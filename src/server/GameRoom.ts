import { DurableObject } from 'cloudflare:workers'
import {
  isFiniteNumber,
  mirrorBall,
  parseBall,
  parseBat,
  ROOM_FULL_CODE,
} from '#/server/updates'
import type {
  BallState,
  BatState,
  Player,
  ServerMessage,
  Signal,
} from '#/server/messages'

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

type Attachment = {
  player: Player
  bat: BatState
  ready: boolean
  // Whether this player serves when the next round starts
  serves: boolean
  rtt?: number
  location?: Location
}

const HINT_KEY = 'hint'
// Milliseconds the lobby keeps sending late joiners to the placed room before the name is reusable
const HINT_LIFETIME = 10 * 60 * 1000
const EARTH_RADIUS_KM = 6371
const MAX_SIGNAL_LENGTH = 16384
const MAX_SERVE_ANGLE = Math.PI / 6
// Milliseconds between the start message and the serve moving, so it reaches
// both players first: the slower round trip plus a margin, within these limits
const MIN_START_DELAY = 200
const MAX_START_DELAY = 1000
const START_MARGIN = 100
// Smaller round trip changes are not stored, to avoid rewriting the attachment on every ping
const RTT_CHANGE = 20
// Each socket may burst this many relayed messages, refilled at this rate per second
const MESSAGE_BUDGET = 60
const MESSAGE_REFILL = 30
const BUDGETED_TYPES = new Set(['bat', 'ball', 'signal'])

type Budget = { tokens: number; t: number }

// Direction is a unit vector in screen-height units
const createServe = (t: number): BallState => {
  const angle = (Math.random() * 2 - 1) * MAX_SERVE_ANGLE
  const vertical = Math.random() < 0.5 ? -1 : 1
  return {
    seq: 1,
    x: 0,
    y: 0,
    dx: Math.sin(angle),
    dy: Math.cos(angle) * vertical,
    t,
  }
}

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
  // Kept in memory, so a budget starts full again after the room hibernates
  private budgets = new WeakMap<WebSocket, Budget>()

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
      // A rejected upgrade only reaches the browser as a generic failure
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      server.close(ROOM_FULL_CODE, 'Room full')
      return new Response(null, { status: 101, webSocket: client })
    }

    const location = parseLocation(request.headers.get(LOCATION_HEADER))
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      player,
      bat: { offset: 0, direction: 0, t: Date.now() },
      ready: false,
      // The host serves first in every new game
      serves: player === 0,
      location,
    } satisfies Attachment)

    this.send(server, { type: 'welcome', player, time: Date.now() })
    const opponent = this.opponentOf(server)
    const opponentLocation = opponent && this.attachment(opponent).location
    if (opponent && location && opponentLocation) {
      // Both players are known, so move the game to a room between them
      const hint = fairestRegion(location, opponentLocation)
      await this.ctx.storage.put(HINT_KEY, hint)
      await this.ctx.storage.setAlarm(Date.now() + HINT_LIFETIME)
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

  // The placement expired, so the next pair in this lobby gets a fresh region
  async alarm() {
    await this.ctx.storage.delete(HINT_KEY)
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return

    let data: Record<string, unknown> | null
    try {
      data = JSON.parse(message)
    } catch {
      return
    }

    if (typeof data?.type !== 'string') return

    // Messages over the budget are dropped
    if (BUDGETED_TYPES.has(data.type) && !this.spend(ws)) return

    const opponent = this.opponentOf(ws)

    switch (data.type) {
      case 'ping':
        this.onPing(ws, data)
        break
      case 'signal':
        if (opponent) this.onSignal(opponent, data)
        break
      case 'bat':
        if (this.inProgress(ws, opponent)) this.onBat(ws, opponent, data)
        break
      case 'ball':
        if (this.inProgress(ws, opponent)) this.onBall(opponent, data)
        break
      case 'ready':
        if (opponent) this.onReady(ws, opponent)
        break
      case 'miss':
        if (this.inProgress(ws, opponent)) this.onMiss(ws, opponent)
        break
    }
  }

  // Bats and the ball only move while both players are ready
  private inProgress(
    ws: WebSocket,
    opponent: WebSocket | undefined,
  ): opponent is WebSocket {
    return (
      !!opponent && this.attachment(ws).ready && this.attachment(opponent).ready
    )
  }

  private onPing(ws: WebSocket, data: Record<string, unknown>) {
    if (!isFiniteNumber(data.t)) return
    this.send(ws, { type: 'pong', t: data.t, time: Date.now() })
    if (!isFiniteNumber(data.rtt)) return
    const attachment = this.attachment(ws)
    const rtt = Math.min(MAX_START_DELAY, Math.max(0, data.rtt))
    if (
      attachment.rtt === undefined ||
      Math.abs(rtt - attachment.rtt) >= RTT_CHANGE
    ) {
      this.update(ws, { rtt })
    }
  }

  private onSignal(opponent: WebSocket, data: Record<string, unknown>) {
    const signal = parseSignal(data.signal)
    if (signal) this.send(opponent, { type: 'signal', signal })
  }

  private onBat(
    ws: WebSocket,
    opponent: WebSocket,
    data: Record<string, unknown>,
  ) {
    const bat = parseBat(data)
    if (!bat) return
    this.update(ws, { bat })
    this.send(opponent, { type: 'bat', ...bat })
  }

  // Each player reports hits and misses on their own bat
  private onBall(opponent: WebSocket, data: Record<string, unknown>) {
    const ball = parseBall(data)
    if (ball) this.send(opponent, { type: 'ball', ...ball })
  }

  private onReady(ws: WebSocket, opponent: WebSocket) {
    if (this.attachment(ws).ready) return
    this.update(ws, { ready: true })
    const opponentReady = this.attachment(opponent).ready
    this.send(ws, { type: 'ready', self: true, opponent: opponentReady })
    this.send(opponent, {
      type: 'ready',
      self: opponentReady,
      opponent: true,
    })
    if (opponentReady) this.startRound(ws, opponent)
  }

  // The round is over, so both players start the next one from the centre
  // and the player who missed serves it
  private onMiss(ws: WebSocket, opponent: WebSocket) {
    for (const player of [ws, opponent]) {
      this.resetPlayer(player, player === ws)
      this.send(player, { type: 'reset' })
    }
  }

  // Both players get the same serve and start time, so the round starts together
  private startRound(a: WebSocket, b: WebSocket) {
    const rtt = Math.max(
      this.attachment(a).rtt ?? MAX_START_DELAY,
      this.attachment(b).rtt ?? MAX_START_DELAY,
    )
    const delay = Math.min(
      MAX_START_DELAY,
      Math.max(MIN_START_DELAY, rtt + START_MARGIN),
    )
    const ball = createServe(Date.now() + delay)
    for (const ws of [a, b]) {
      // The serve is created in the serving player's view; the other sees it mirrored
      const serves = this.attachment(ws).serves
      this.send(ws, { type: 'start', ball: serves ? ball : mirrorBall(ball) })
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
    try {
      ws.close(1011, 'WebSocket error')
    } catch {
      // Already closed
    }
  }

  private leave(ws: WebSocket) {
    const opponent = this.opponentOf(ws)
    if (!opponent) return
    // The next opponent starts a fresh game, so both must ready up again
    this.resetPlayer(opponent, this.attachment(opponent).player === 0)
    this.send(opponent, { type: 'opponent', connected: false })
  }

  private resetPlayer(ws: WebSocket, serves: boolean) {
    this.update(ws, {
      bat: { offset: 0, direction: 0, t: Date.now() },
      ready: false,
      serves,
    })
  }

  // Takes one message from the socket's budget, if any is left
  private spend(ws: WebSocket) {
    const now = Date.now()
    const budget = this.budgets.get(ws) ?? { tokens: MESSAGE_BUDGET, t: now }
    budget.tokens = Math.min(
      MESSAGE_BUDGET,
      budget.tokens + ((now - budget.t) / 1000) * MESSAGE_REFILL,
    )
    budget.t = now
    this.budgets.set(ws, budget)
    if (budget.tokens < 1) return false
    budget.tokens--
    return true
  }

  private opponentOf(ws: WebSocket) {
    return this.ctx.getWebSockets().find((other) => other !== ws)
  }

  private attachment(ws: WebSocket) {
    return ws.deserializeAttachment() as Attachment
  }

  private update(ws: WebSocket, patch: Partial<Attachment>) {
    ws.serializeAttachment({
      ...this.attachment(ws),
      ...patch,
    } satisfies Attachment)
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // Socket is closing
    }
  }
}
