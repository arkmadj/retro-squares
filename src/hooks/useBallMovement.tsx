import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { BallState } from '#/server/GameRoom'

// Position from the centre of the game screen, as fractions of its width and height
export type BallPosition = { x: number; y: number }

// `predicted` marks a hit on the opponent's bat that they have not confirmed yet
export type LocalBallState = BallState & { predicted?: boolean }

type Bounds = { left: number; right: number; top: number; bottom: number }

// Ball radius as fractions of the game screen, and its height-to-width ratio
type Geometry = { rx: number; ry: number; aspect: number }

type UseBallMovementOptions = {
  ballRef: RefObject<HTMLElement | null>
  topBatRef: RefObject<HTMLElement | null>
  bottomBatRef: RefObject<HTMLElement | null>
  // Current trajectory, shared with the opponent's updates
  ballState: RefObject<LocalBallState | null>
  active: boolean
  // Whether this player serves when the round starts
  serveFirst: boolean
  // Current time on the shared clock, in milliseconds
  now: () => number
  // Fraction of the game screen height moved per second
  speed?: number
  // Called when this player hits the ball or serves
  onEvent?: (ball: BallState) => void
  // Called once when the ball gets past this player's bat, ending the round
  onMiss?: () => void
}

const MAX_BOUNCE_ANGLE = Math.PI / 3
const MAX_SERVE_ANGLE = Math.PI / 6
// Milliseconds before a served ball moves, so both players see it start together
const SERVE_DELAY = 600
// Seconds for a correction to shrink by about two thirds
const SMOOTHING = 0.08
// Corrections larger than this jump straight to the new position
const SNAP_DISTANCE = 0.2

export const setBallPosition = (ball: HTMLElement, { x, y }: BallPosition) => {
  const container = ball.parentElement
  if (!container) return
  ball.style.transform = `translate(${x * container.clientWidth}px, ${y * container.clientHeight}px)`
}

// Both players see themselves at the bottom, so the opponent's view is rotated
export const mirrorBall = (ball: BallState): BallState => ({
  ...ball,
  x: -ball.x,
  y: -ball.y,
  dx: -ball.dx,
  dy: -ball.dy,
})

// Accepts the opponent's trajectory if it is newer than ours
export const receiveBall = (
  ballState: RefObject<LocalBallState | null>,
  ball: BallState,
) => {
  const current = ballState.current
  if (
    !current ||
    ball.seq > current.seq ||
    (ball.seq === current.seq && current.predicted)
  ) {
    ballState.current = ball
  }
}

// Direction is a unit vector in screen-height units
const serve = (seq: number, t: number): BallState => {
  const angle = (Math.random() * 2 - 1) * MAX_SERVE_ANGLE
  const vertical = Math.random() < 0.5 ? -1 : 1
  return {
    seq,
    x: 0,
    y: 0,
    dx: Math.sin(angle),
    dy: Math.cos(angle) * vertical,
    t,
  }
}

// Bounces a coordinate back and forth between -limit and limit
const fold = (value: number, limit: number) => {
  if (limit <= 0) return 0
  const period = 4 * limit
  const u = (((value + limit) % period) + period) % period
  return u < 2 * limit ? u - limit : 3 * limit - u
}

// Ball position at `time`, including bounces off the side walls
const positionAt = (
  ball: BallState,
  time: number,
  speed: number,
  { rx, aspect }: Geometry,
): BallPosition => {
  const elapsed = Math.max(0, time - ball.t) / 1000
  return {
    x: fold(ball.x + ball.dx * speed * elapsed * aspect, 0.5 - rx),
    y: ball.y + ball.dy * speed * elapsed,
  }
}

// Bounds from the centre of the game screen, as fractions of its width and height
const getBounds = (element: HTMLElement, container: DOMRect): Bounds => {
  const rect = element.getBoundingClientRect()
  return {
    left: (rect.left - container.left) / container.width - 0.5,
    right: (rect.right - container.left) / container.width - 0.5,
    top: (rect.top - container.top) / container.height - 0.5,
    bottom: (rect.bottom - container.top) / container.height - 0.5,
  }
}

// Hitting further from the bat's centre sends the ball off at a steeper angle
const bounceAngle = (x: number, bat: Bounds) => {
  const centre = (bat.left + bat.right) / 2
  const halfWidth = (bat.right - bat.left) / 2
  const hit = Math.min(1, Math.max(-1, (x - centre) / halfWidth))
  return hit * MAX_BOUNCE_ANGLE
}

// Both players run the ball from the shared trajectory. Each player decides
// hits and misses on their own (bottom) bat; hits on the opponent's bat are
// predicted until the opponent confirms or corrects them.
export const useBallMovement = ({
  ballRef,
  topBatRef,
  bottomBatRef,
  ballState,
  active,
  serveFirst,
  now,
  speed = 0.6,
  onEvent,
  onMiss,
}: UseBallMovementOptions) => {
  const onEventRef = useRef(onEvent)
  const onMissRef = useRef(onMiss)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    onMissRef.current = onMiss
  }, [onMiss])

  useEffect(() => {
    const ball = ballRef.current
    if (!ball) return

    setBallPosition(ball, { x: 0, y: 0 })
    if (!active) return

    const emit = (next: BallState) => {
      ballState.current = next
      onEventRef.current?.(next)
    }

    if (serveFirst) {
      emit(serve((ballState.current?.seq ?? 0) + 1, now() + SERVE_DELAY))
    }

    let frame = requestAnimationFrame(tick)
    let lastState: LocalBallState | null = null
    let lastTime: number | null = null
    let previous: BallPosition = { x: 0, y: 0 }
    let displayed: BallPosition = { x: 0, y: 0 }
    let error: BallPosition = { x: 0, y: 0 }
    let missed = false

    function tick(time: number) {
      frame = requestAnimationFrame(tick)
      const container = ball?.parentElement
      if (!ball || !container) return

      const delta = lastTime === null ? 0 : (time - lastTime) / 1000
      lastTime = time

      let state = ballState.current
      if (!state) return

      const screen = container.getBoundingClientRect()
      const geometry: Geometry = {
        rx: ball.offsetWidth / 2 / screen.width,
        ry: ball.offsetHeight / 2 / screen.height,
        aspect: screen.height / screen.width,
      }
      const { rx, ry } = geometry
      const t = now()

      // Sweep from where the ball was last frame, or from the start of a new trajectory
      const from = state === lastState ? previous : { x: state.x, y: state.y }
      let position = positionAt(state, t, speed, geometry)

      const topBat = topBatRef.current && getBounds(topBatRef.current, screen)
      const bottomBat =
        bottomBatRef.current && getBounds(bottomBatRef.current, screen)
      const overlapsX = (bat: Bounds) =>
        position.x + rx >= bat.left && position.x - rx <= bat.right

      if (
        bottomBat &&
        state.dy > 0 &&
        from.y + ry <= bottomBat.bottom &&
        position.y + ry >= bottomBat.top &&
        overlapsX(bottomBat)
      ) {
        const angle = bounceAngle(position.x, bottomBat)
        emit({
          seq: state.seq + 1,
          x: position.x,
          y: bottomBat.top - ry,
          dx: Math.sin(angle),
          dy: -Math.cos(angle),
          t,
        })
      } else if (state.dy > 0 && position.y > 0.5 + ry) {
        if (!missed) {
          missed = true
          onMissRef.current?.()
        }
      } else if (
        topBat &&
        state.dy < 0 &&
        from.y - ry >= topBat.top &&
        position.y - ry <= topBat.bottom &&
        overlapsX(topBat)
      ) {
        const angle = bounceAngle(position.x, topBat)
        ballState.current = {
          seq: state.seq + 1,
          x: position.x,
          y: topBat.bottom + ry,
          dx: Math.sin(angle),
          dy: Math.cos(angle),
          t,
          predicted: true,
        }
      } else if (state.dy < 0 && position.y < -0.5 - ry) {
        // Wait off screen for the opponent to serve
        position = { x: position.x, y: -0.5 - ry }
      }

      if (ballState.current && ballState.current !== state) {
        state = ballState.current
        position = positionAt(state, t, speed, geometry)
      }

      if (state !== lastState) {
        const offset = {
          x: displayed.x - position.x,
          y: displayed.y - position.y,
        }
        const snap =
          lastState === null ||
          state.t > t ||
          Math.hypot(offset.x, offset.y) > SNAP_DISTANCE
        error = snap ? { x: 0, y: 0 } : offset
        lastState = state
      }

      const decay = Math.exp(-delta / SMOOTHING)
      error = { x: error.x * decay, y: error.y * decay }
      displayed = { x: position.x + error.x, y: position.y + error.y }
      previous = position
      setBallPosition(ball, displayed)
    }

    return () => {
      cancelAnimationFrame(frame)
      ballState.current = null
    }
  }, [
    active,
    serveFirst,
    ballRef,
    topBatRef,
    bottomBatRef,
    ballState,
    now,
    speed,
  ])
}
