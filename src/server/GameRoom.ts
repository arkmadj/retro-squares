import { DurableObject } from 'cloudflare:workers'

export type Player = 0 | 1

export type ClientMessage =
  { type: 'move'; offset: number } | { type: 'ball'; x: number; y: number }

export type ServerMessage =
  | { type: 'welcome'; player: Player }
  | { type: 'opponent'; connected: boolean }
  | { type: 'move'; offset: number }
  | { type: 'ball'; x: number; y: number }

type Attachment = { player: Player; offset: number }

const MAX_OFFSET = 0.5
const MAX_BALL_POSITION = 1

const clamp = (value: number, max: number) =>
  Math.min(max, Math.max(-max, value))

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export class GameRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const taken = this.ctx
      .getWebSockets()
      .map((ws) => this.attachment(ws).player)
    const player = ([0, 1] as const).find((p) => !taken.includes(p))
    if (player === undefined) {
      return new Response('Room full', { status: 409 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ player, offset: 0 } satisfies Attachment)

    this.send(server, { type: 'welcome', player })
    const opponent = this.opponentOf(server)
    if (opponent) {
      this.send(server, { type: 'opponent', connected: true })
      this.send(server, {
        type: 'move',
        offset: this.attachment(opponent).offset,
      })
      this.send(opponent, { type: 'opponent', connected: true })
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return

    let data: Record<string, unknown> | null
    try {
      data = JSON.parse(message)
    } catch {
      return
    }

    const opponent = this.opponentOf(ws)

    if (data?.type === 'move' && isFiniteNumber(data.offset)) {
      const offset = clamp(data.offset, MAX_OFFSET)
      ws.serializeAttachment({
        ...this.attachment(ws),
        offset,
      } satisfies Attachment)
      if (opponent) this.send(opponent, { type: 'move', offset })
    } else if (
      data?.type === 'ball' &&
      isFiniteNumber(data.x) &&
      isFiniteNumber(data.y) &&
      // Player 0 runs the ball
      this.attachment(ws).player === 0
    ) {
      if (opponent) {
        this.send(opponent, {
          type: 'ball',
          x: clamp(data.x, MAX_BALL_POSITION),
          y: clamp(data.y, MAX_BALL_POSITION),
        })
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.leave(ws)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed
    }
  }

  webSocketError(ws: WebSocket) {
    this.leave(ws)
  }

  private leave(ws: WebSocket) {
    const opponent = this.opponentOf(ws)
    if (opponent) this.send(opponent, { type: 'opponent', connected: false })
  }

  private opponentOf(ws: WebSocket) {
    return this.ctx.getWebSockets().find((other) => other !== ws)
  }

  private attachment(ws: WebSocket) {
    return ws.deserializeAttachment() as Attachment
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // Socket is closing
    }
  }
}
