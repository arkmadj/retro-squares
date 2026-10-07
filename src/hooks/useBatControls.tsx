import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { BatState, Direction } from '#/server/GameRoom'

type UseBatControlsOptions = {
  batRef: RefObject<HTMLElement | null>
  leftKeys?: string[]
  rightKeys?: string[]
  // Fraction of the game screen width moved per second
  speed?: number
  // Called when the bat starts, stops or changes direction
  onChange?: (bat: Omit<BatState, 't'>) => void
  // When false, the bat is held at the centre and ignores input
  enabled?: boolean
}

type UseRemoteBatOptions = {
  batRef: RefObject<HTMLElement | null>
  batState: RefObject<BatState | null>
  // Current time on the shared clock, in milliseconds
  now: () => number
  speed?: number
}

const DEFAULT_LEFT_KEYS = ['ArrowLeft', 'a', 'A']
const DEFAULT_RIGHT_KEYS = ['ArrowRight', 'd', 'D']
// Seconds for a correction to shrink by about two thirds
const SMOOTHING = 0.08

// Offset is from the centre of the game screen, as a fraction of its width
export const setBatOffset = (bat: HTMLElement, offset: number) => {
  const container = bat.parentElement
  if (!container) return
  const batToContainer = bat.offsetWidth / container.clientWidth
  bat.style.transform = `translateX(${(offset / batToContainer) * 100}%)`
}

const getMaxOffset = (bat: HTMLElement, container: HTMLElement) =>
  (1 - bat.offsetWidth / container.clientWidth) / 2

export const useBatControls = ({
  batRef,
  leftKeys = DEFAULT_LEFT_KEYS,
  rightKeys = DEFAULT_RIGHT_KEYS,
  speed = 1,
  onChange,
  enabled = true,
}: UseBatControlsOptions) => {
  const pressed = useRef({ left: false, right: false })
  // Offset from the centre of the game screen, as a fraction of its width
  const offset = useRef(0)
  const direction = useRef<Direction>(0)
  const frame = useRef<number | null>(null)
  const lastTime = useRef<number | null>(null)
  const onChangeRef = useRef(onChange)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    enabledRef.current = enabled
    if (enabled) return

    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    pressed.current = { left: false, right: false }
    direction.current = 0
    offset.current = 0
    lastTime.current = null
    if (batRef.current) setBatOffset(batRef.current, 0)
  }, [enabled, batRef])

  const getDirection = (): Direction =>
    ((pressed.current.right ? 1 : 0) -
      (pressed.current.left ? 1 : 0)) as Direction

  // Moves the bat in its current direction up to `time`
  const advance = useCallback(
    (time: number) => {
      const bat = batRef.current
      const container = bat?.parentElement
      if (!bat || !container) return

      const delta =
        lastTime.current === null
          ? 0
          : Math.max(0, time - lastTime.current) / 1000
      lastTime.current = time

      const maxOffset = getMaxOffset(bat, container)
      const next = offset.current + direction.current * speed * delta
      offset.current = Math.min(maxOffset, Math.max(-maxOffset, next))
      setBatOffset(bat, offset.current)
    },
    [batRef, speed],
  )

  const tick = useCallback(
    (time: number) => {
      advance(time)
      if (direction.current === 0) {
        frame.current = null
        lastTime.current = null
        return
      }
      frame.current = requestAnimationFrame(tick)
    },
    [advance],
  )

  const updateDirection = useCallback(() => {
    if (!enabledRef.current) return
    const next = getDirection()
    if (next === direction.current) return

    // Settle the position at the moment of the change so the opponent can
    // reproduce the movement exactly
    advance(performance.now())
    direction.current = next
    onChangeRef.current?.({ offset: offset.current, direction: next })

    if (next !== 0 && frame.current === null) {
      frame.current = requestAnimationFrame(tick)
    }
  }, [advance, tick])

  const moveLeft = useCallback(
    (active = true) => {
      pressed.current.left = active
      updateDirection()
    },
    [updateDirection],
  )

  const moveRight = useCallback(
    (active = true) => {
      pressed.current.right = active
      updateDirection()
    },
    [updateDirection],
  )

  const stop = useCallback(() => {
    pressed.current = { left: false, right: false }
    updateDirection()
  }, [updateDirection])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const active = event.type === 'keydown'
      if (leftKeys.includes(event.key)) {
        event.preventDefault()
        moveLeft(active)
      } else if (rightKeys.includes(event.key)) {
        event.preventDefault()
        moveRight(active)
      }
    }

    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKey)
    window.addEventListener('blur', stop)

    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('keyup', handleKey)
      window.removeEventListener('blur', stop)
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [leftKeys, rightKeys, moveLeft, moveRight, stop])

  return { moveLeft, moveRight, stop }
}

// Draws the opponent's bat by replaying their latest input from its timestamp,
// easing out the jump when a late update arrives
export const useRemoteBat = ({
  batRef,
  batState,
  now,
  speed = 1,
}: UseRemoteBatOptions) => {
  useEffect(() => {
    let frame = requestAnimationFrame(tick)
    let lastState: BatState | null = null
    let lastTime: number | null = null
    let displayed = 0
    let error = 0

    function tick(time: number) {
      frame = requestAnimationFrame(tick)
      const bat = batRef.current
      const container = bat?.parentElement
      const state = batState.current
      if (!bat || !container || !state) return

      const maxOffset = getMaxOffset(bat, container)
      const elapsed = Math.max(0, now() - state.t) / 1000
      const target = Math.min(
        maxOffset,
        Math.max(-maxOffset, state.offset + state.direction * speed * elapsed),
      )

      if (state !== lastState) {
        if (lastState) error = displayed - target
        lastState = state
      }

      const delta = lastTime === null ? 0 : (time - lastTime) / 1000
      lastTime = time
      error *= Math.exp(-delta / SMOOTHING)
      displayed = target + error
      setBatOffset(bat, displayed)
    }

    return () => cancelAnimationFrame(frame)
  }, [batRef, batState, now, speed])
}
