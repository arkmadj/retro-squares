import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

type Direction = -1 | 0 | 1

type UseBatControlsOptions = {
  batRef: RefObject<HTMLElement | null>
  leftKeys?: string[]
  rightKeys?: string[]
  // Fraction of the game screen width moved per second
  speed?: number
  onMove?: (offset: number) => void
}

const DEFAULT_LEFT_KEYS = ['ArrowLeft', 'a', 'A']
const DEFAULT_RIGHT_KEYS = ['ArrowRight', 'd', 'D']

// Offset is from the centre of the game screen, as a fraction of its width
export const setBatOffset = (bat: HTMLElement, offset: number) => {
  const container = bat.parentElement
  if (!container) return
  const batToContainer = bat.offsetWidth / container.clientWidth
  bat.style.transform = `translateX(${(offset / batToContainer) * 100}%)`
}

export const useBatControls = ({
  batRef,
  leftKeys = DEFAULT_LEFT_KEYS,
  rightKeys = DEFAULT_RIGHT_KEYS,
  speed = 1,
  onMove,
}: UseBatControlsOptions) => {
  const pressed = useRef({ left: false, right: false })
  // Offset from the centre of the game screen, as a fraction of its width
  const offset = useRef(0)
  const frame = useRef<number | null>(null)
  const lastTime = useRef<number | null>(null)
  const onMoveRef = useRef(onMove)

  useEffect(() => {
    onMoveRef.current = onMove
  }, [onMove])

  const getDirection = (): Direction =>
    ((pressed.current.right ? 1 : 0) -
      (pressed.current.left ? 1 : 0)) as Direction

  const tick = useCallback(
    (time: number) => {
      const bat = batRef.current
      const container = bat?.parentElement
      const direction = getDirection()

      if (!bat || !container || direction === 0) {
        frame.current = null
        lastTime.current = null
        return
      }

      const delta =
        lastTime.current === null ? 0 : (time - lastTime.current) / 1000
      lastTime.current = time

      const batToContainer = bat.offsetWidth / container.clientWidth
      const maxOffset = (1 - batToContainer) / 2
      const next = offset.current + direction * speed * delta
      offset.current = Math.min(maxOffset, Math.max(-maxOffset, next))
      setBatOffset(bat, offset.current)
      onMoveRef.current?.(offset.current)

      frame.current = requestAnimationFrame(tick)
    },
    [batRef, speed],
  )

  const startLoop = useCallback(() => {
    if (frame.current === null) {
      frame.current = requestAnimationFrame(tick)
    }
  }, [tick])

  const moveLeft = useCallback(
    (active = true) => {
      pressed.current.left = active
      startLoop()
    },
    [startLoop],
  )

  const moveRight = useCallback(
    (active = true) => {
      pressed.current.right = active
      startLoop()
    },
    [startLoop],
  )

  const stop = useCallback(() => {
    pressed.current = { left: false, right: false }
  }, [])

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
