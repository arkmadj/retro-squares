// Bat and ball checks shared by the server and the browser, which receives
// these updates directly from the opponent. Kept free of worker imports.
import type { BallState, BatState, Direction } from '#/server/GameRoom'

// Close code sent when both player slots are taken
export const ROOM_FULL_CODE = 4009

export type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

// Where the browser gets ICE servers, including short-lived TURN credentials
export const ICE_SERVERS_PATH = '/api/ice-servers'
// Seconds the TURN credentials stay valid; a game's connection must not outlive them
export const ICE_CREDENTIAL_TTL = 4 * 60 * 60
// Used without TURN, or when credentials can't be fetched
export const STUN_SERVERS: IceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

const MAX_OFFSET = 0.5
const MAX_BALL_POSITION = 1

const clamp = (value: number, max: number) =>
  Math.min(max, Math.max(-max, value))

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const isDirection = (value: unknown): value is Direction =>
  value === -1 || value === 0 || value === 1

// Both players see themselves at the bottom, so the opponent's view is rotated
export const mirrorBall = (ball: BallState): BallState => ({
  ...ball,
  x: -ball.x,
  y: -ball.y,
  dx: -ball.dx,
  dy: -ball.dy,
})

// Copies only the known fields and keeps the bat on the screen
export const parseBat = (
  data: Record<string, unknown>,
): BatState | undefined => {
  if (
    !isFiniteNumber(data.offset) ||
    !isDirection(data.direction) ||
    !isFiniteNumber(data.t)
  ) {
    return
  }
  return {
    offset: clamp(data.offset, MAX_OFFSET),
    direction: data.direction,
    t: data.t,
  }
}

// Copies only the known fields and keeps the ball near the screen
export const parseBall = (
  data: Record<string, unknown>,
): BallState | undefined => {
  if (
    !Number.isSafeInteger(data.seq) ||
    !isFiniteNumber(data.x) ||
    !isFiniteNumber(data.y) ||
    !isFiniteNumber(data.dx) ||
    !isFiniteNumber(data.dy) ||
    !isFiniteNumber(data.t)
  ) {
    return
  }
  return {
    seq: data.seq as number,
    x: clamp(data.x, MAX_BALL_POSITION),
    y: clamp(data.y, MAX_BALL_POSITION),
    dx: clamp(data.dx, 1),
    dy: clamp(data.dy, 1),
    t: data.t,
  }
}
