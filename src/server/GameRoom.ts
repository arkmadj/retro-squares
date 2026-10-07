import { DurableObject } from 'cloudflare:workers'

export type Player = 0 | 1

export type Direction = -1 | 0 | 1

// Times are in server clock milliseconds
export type BatState = { offset: number; direction: Direction; t: number }

// Ball trajectory starting at (x, y) at time t, heading along unit vector (dx, dy)
export type BallState = {
  seq: number
  x: number
  y: number
  dx: number
  dy: number
  t: number
}

// WebRTC negotiation relayed between players so they can connect directly
export type Signal =
  | { kind: 'description'; type: 'offer' | 'answer'; sdp: string }
  | {
      kind: 'candidate'
      candidate: string
      sdpMid: string | null
      sdpMLineIndex: number | null
    }

export type ClientMessage =
  | { type: 'ping'; t: number }
  | ({ type: 'bat' } & BatState)
  | ({ type: 'ball' } & BallState)
  | { type: 'ready' }
  | { type: 'miss' }
  | { type: 'signal'; signal: Signal }

type Location = { latitude: number; longitude: number }

// Rough centre of the data centres each location hint places a room in
const REGIONS = {
  wnam: { latitude: 37.4, longitude: -122.1 },
  enam: { latitude: 39.0, longitude: -77.5 },
  weur: { latitude: 51.5, longitude: -0.1 },
  eeur: { latitude: 52.2, longitude: 21.0 },
  'apac-ne': { latitude: 35.7, longitude: 139.7 },
  'apac-se': { latitude: 1.35, longitude: 103.8 },
  oc: { latitude: -33.9, longitude: 151.2 },
} satisfies Partial<Record<DurableObjectLocationHint, Location>>

export type RoomHint = keyof typeof REGIONS

export const isRoomHint = (value: string): value is RoomHint =>
  Object.hasOwn(REGIONS, value)

// Set by the worker on lobby connections as "latitude,longitude"
export const LOCATION_HEADER = 'X-Player-Location'

export type ServerMessage =
  | { type: 'welcome'; player: Player; time: number }
  | { type: 'opponent'; connected: boolean }
  | { type: 'pong'; t: number; time: number }
  | { type: 'relocate'; hint: RoomHint }
  | ({ type: 'bat' } & BatState)
  | ({ type: 'ball' } & BallState)
  | { type: 'ready'; self: boolean; opponent: boolean }
  | { type: 'reset'; serve: boolean }
  | { type: 'signal'; signal: Signal }

type Attachment = {
  player: Player
  bat: BatState
  ready: boolean
  location?: Location
}

const MAX_OFFSET = 0.5
const MAX_BALL_POSITION = 1
const HINT_KEY = 'hint'
const EARTH_RADIUS_KM = 6371
const MAX_SIGNAL_LENGTH = 16384

const clamp = (value: number, max: number) =>
  Math.min(max, Math.max(-max, value))

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isDirection = (value: unknown): value is Direction =>
  value === -1 || value === 0 || value === 1

const isSignalText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_SIGNAL_LENGTH

// Copies only the known fields so nothing else is relayed
const parseSignal = (value: unknown): Signal | undefined => {
  if (typeof value !== 'object' || value === null) return
  const signal = value as Record<string, unknown>
  if (
    signal.kind === 'description' &&
    (signal.type === 'offer' || signal.type === 'answer') &&
    isSignalText(signal.sdp)
  ) {
    return { kind: 'description', type: signal.type, sdp: signal.sdp }
  }
  if (
    signal.kind === 'candidate' &&
    isSignalText(signal.candidate) &&
    (signal.sdpMid === null || isSignalText(signal.sdpMid)) &&
    (signal.sdpMLineIndex === null ||
      Number.isSafeInteger(signal.sdpMLineIndex))
  ) {
    return {
      kind: 'candidate',
      candidate: signal.candidate,
      sdpMid: signal.sdpMid,
      sdpMLineIndex: signal.sdpMLineIndex as number | null,
    }
  }
}

const parseLocation = (value: string | null): Location | undefined => {
  const [latitude, longitude] = (value ?? '').split(',').map(Number)
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return
  return { latitude, longitude }
}

const distance = (a: Location, b: Location) => {
  const rad = Math.PI / 180
  const h =
    Math.sin(((b.latitude - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(((b.longitude - a.longitude) * rad) / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

// The region whose further player is nearest, so neither player is favoured
const fairestRegion = (a: Location, b: Location) => {
  const furthest = (region: Location) =>
    Math.max(distance(a, region), distance(b, region))
  return (Object.keys(REGIONS) as RoomHint[]).reduce((best, hint) =>
    furthest(REGIONS[hint]) < furthest(REGIONS[best]) ? hint : best,
  )
}

export class GameRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    // This lobby already placed the game, so send late joiners there
    const placed = await this.ctx.storage.get<RoomHint>(HINT_KEY)
    if (placed) {
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      this.send(server, { type: 'relocate', hint: placed })
      server.close(1000, 'Relocated')
      return new Response(null, { status: 101, webSocket: client })
    }

    const taken = this.ctx
      .getWebSockets()
      .map((ws) => this.attachment(ws).player)
    // Players keep their lobby number in the relocated room, so the host stays player 0
    const requested = Number(new URL(request.url).searchParams.get('player'))
    const order: Player[] = requested === 1 ? [1, 0] : [0, 1]
    const player = order.find((p) => !taken.includes(p))
    if (player === undefined) {
      return new Response('Room full', { status: 409 })
    }

    const location = parseLocation(request.headers.get(LOCATION_HEADER))
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      player,
      bat: { offset: 0, direction: 0, t: Date.now() },
      ready: false,
      location,
    } satisfies Attachment)

    this.send(server, { type: 'welcome', player, time: Date.now() })
    const opponent = this.opponentOf(server)
    const opponentLocation = opponent && this.attachment(opponent).location
    if (opponent && location && opponentLocation) {
      // Both players are known, so move the game to a room between them
      const hint = fairestRegion(location, opponentLocation)
      await this.ctx.storage.put(HINT_KEY, hint)
      for (const ws of [server, opponent]) {
        this.send(ws, { type: 'relocate', hint })
        ws.close(1000, 'Relocated')
      }
    } else if (opponent) {
      this.send(server, { type: 'opponent', connected: true })
      this.send(server, { type: 'bat', ...this.attachment(opponent).bat })
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
    // Bats and the ball only move while both players are ready
    const inProgress =
      !!opponent && this.attachment(ws).ready && this.attachment(opponent).ready

    if (data?.type === 'ping' && isFiniteNumber(data.t)) {
      this.send(ws, { type: 'pong', t: data.t, time: Date.now() })
    } else if (data?.type === 'signal' && opponent) {
      const signal = parseSignal(data.signal)
      if (signal) this.send(opponent, { type: 'signal', signal })
    } else if (
      inProgress &&
      data?.type === 'bat' &&
      isFiniteNumber(data.offset) &&
      isDirection(data.direction) &&
      isFiniteNumber(data.t)
    ) {
      const bat: BatState = {
        offset: clamp(data.offset, MAX_OFFSET),
        direction: data.direction,
        t: data.t,
      }
      ws.serializeAttachment({
        ...this.attachment(ws),
        bat,
      } satisfies Attachment)
      this.send(opponent, { type: 'bat', ...bat })
    } else if (
      inProgress &&
      data?.type === 'ball' &&
      Number.isSafeInteger(data.seq) &&
      isFiniteNumber(data.x) &&
      isFiniteNumber(data.y) &&
      isFiniteNumber(data.dx) &&
      isFiniteNumber(data.dy) &&
      isFiniteNumber(data.t)
    ) {
      // Each player reports hits and misses on their own bat
      this.send(opponent, {
        type: 'ball',
        seq: data.seq as number,
        x: clamp(data.x, MAX_BALL_POSITION),
        y: clamp(data.y, MAX_BALL_POSITION),
        dx: clamp(data.dx, 1),
        dy: clamp(data.dy, 1),
        t: data.t,
      })
    } else if (data?.type === 'ready' && opponent) {
      ws.serializeAttachment({
        ...this.attachment(ws),
        ready: true,
      } satisfies Attachment)
      const opponentReady = this.attachment(opponent).ready
      this.send(ws, { type: 'ready', self: true, opponent: opponentReady })
      this.send(opponent, {
        type: 'ready',
        self: opponentReady,
        opponent: true,
      })
    } else if (inProgress && data?.type === 'miss') {
      // The round is over, so both players start the next one from the centre
      // and the player who missed serves it
      for (const player of [ws, opponent]) {
        this.resetPlayer(player)
        this.send(player, { type: 'reset', serve: player === ws })
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
    if (!opponent) return
    // The next opponent starts a fresh game, so both must ready up again
    this.resetPlayer(opponent)
    this.send(opponent, { type: 'opponent', connected: false })
  }

  private resetPlayer(ws: WebSocket) {
    ws.serializeAttachment({
      ...this.attachment(ws),
      bat: { offset: 0, direction: 0, t: Date.now() },
      ready: false,
    } satisfies Attachment)
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
