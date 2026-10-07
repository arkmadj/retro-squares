// Message types shared by the server and the browser. Kept free of worker imports.
import type { RoomHint } from '#/server/GameRoom'

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
  // `rtt` is the player's measured round trip to the server, in milliseconds
  | { type: 'ping'; t: number; rtt?: number }
  | ({ type: 'bat' } & BatState)
  | ({ type: 'ball' } & BallState)
  | { type: 'ready' }
  | { type: 'miss' }
  | { type: 'signal'; signal: Signal }

export type ServerMessage =
  | { type: 'welcome'; player: Player; time: number }
  | { type: 'opponent'; connected: boolean }
  | { type: 'pong'; t: number; time: number }
  | { type: 'relocate'; hint: RoomHint }
  | ({ type: 'bat' } & BatState)
  | ({ type: 'ball' } & BallState)
  | { type: 'ready'; self: boolean; opponent: boolean }
  // The round's serve in this player's view; the ball moves from `ball.t`
  | { type: 'start'; ball: BallState }
  | { type: 'reset' }
  | { type: 'signal'; signal: Signal }
