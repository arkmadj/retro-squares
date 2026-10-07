import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Position from the centre of the game screen, as fractions of its width and height
export type BallPosition = { x: number; y: number }

type Bounds = { left: number; right: number; top: number; bottom: number }

type UseBallMovementOptions = {
  ballRef: RefObject<HTMLElement | null>
  topBatRef: RefObject<HTMLElement | null>
  bottomBatRef: RefObject<HTMLElement | null>
  active: boolean
  // Fraction of the game screen height moved per second
  speed?: number
  onMove?: (position: BallPosition) => void
}

const MAX_BOUNCE_ANGLE = Math.PI / 3
const MAX_SERVE_ANGLE = Math.PI / 6
const MAX_DELTA = 0.05

export const setBallPosition = (ball: HTMLElement, { x, y }: BallPosition) => {
  const container = ball.parentElement
  if (!container) return
  ball.style.transform = `translate(${x * container.clientWidth}px, ${y * container.clientHeight}px)`
}

// Unit vector in screen-height units
const serve = () => {
  const angle = (Math.random() * 2 - 1) * MAX_SERVE_ANGLE
  const vertical = Math.random() < 0.5 ? -1 : 1
  return { x: Math.sin(angle), y: Math.cos(angle) * vertical }
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

export const useBallMovement = ({
  ballRef,
  topBatRef,
  bottomBatRef,
  active,
  speed = 0.6,
  onMove,
}: UseBallMovementOptions) => {
  const position = useRef<BallPosition>({ x: 0, y: 0 })
  const velocity = useRef(serve())
  const onMoveRef = useRef(onMove)

  useEffect(() => {
    onMoveRef.current = onMove
  }, [onMove])

  useEffect(() => {
    const ball = ballRef.current
    if (!ball) return

    position.current = { x: 0, y: 0 }
    velocity.current = serve()
    setBallPosition(ball, position.current)
    if (!active) return

    let frame = requestAnimationFrame(tick)
    let lastTime: number | null = null

    function tick(time: number) {
      frame = requestAnimationFrame(tick)
      const container = ball?.parentElement
      if (!ball || !container) return

      const delta =
        lastTime === null ? 0 : Math.min(MAX_DELTA, (time - lastTime) / 1000)
      lastTime = time

      const screen = container.getBoundingClientRect()
      const rx = ball.offsetWidth / 2 / screen.width
      const ry = ball.offsetHeight / 2 / screen.height
      const v = { ...velocity.current }
      let x =
        position.current.x +
        v.x * speed * delta * (screen.height / screen.width)
      let y = position.current.y + v.y * speed * delta

      if (Math.abs(x) > 0.5 - rx) {
        x = Math.sign(x) * (0.5 - rx)
        v.x = -Math.sign(x) * Math.abs(v.x)
      }

      const topBat = topBatRef.current && getBounds(topBatRef.current, screen)
      const bottomBat =
        bottomBatRef.current && getBounds(bottomBatRef.current, screen)
      const overlapsX = (bat: Bounds) =>
        x + rx >= bat.left && x - rx <= bat.right

      if (
        bottomBat &&
        v.y > 0 &&
        y + ry >= bottomBat.top &&
        y - ry <= bottomBat.bottom &&
        overlapsX(bottomBat)
      ) {
        const angle = bounceAngle(x, bottomBat)
        v.x = Math.sin(angle)
        v.y = -Math.cos(angle)
        y = bottomBat.top - ry
      } else if (
        topBat &&
        v.y < 0 &&
        y - ry <= topBat.bottom &&
        y + ry >= topBat.top &&
        overlapsX(topBat)
      ) {
        const angle = bounceAngle(x, topBat)
        v.x = Math.sin(angle)
        v.y = Math.cos(angle)
        y = topBat.bottom + ry
      } else if (Math.abs(y) > 0.5 + ry) {
        x = 0
        y = 0
        Object.assign(v, serve())
      }

      velocity.current = v
      position.current = { x, y }
      setBallPosition(ball, position.current)
      onMoveRef.current?.(position.current)
    }

    return () => cancelAnimationFrame(frame)
  }, [active, ballRef, topBatRef, bottomBatRef, speed])
}
