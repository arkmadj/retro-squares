import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { setBallPosition, useBallMovement } from '#/hooks/useBallMovement'
import type { BallPosition } from '#/hooks/useBallMovement'
import { setBatOffset, useBatControls } from '#/hooks/useBatControls'
import { useGameRoom } from '#/hooks/useGameRoom'
import type { RoomStatus } from '#/hooks/useGameRoom'

type PlaySearch = { room?: string }

export const Route = createFileRoute('/play')({
  validateSearch: (search: Record<string, unknown>): PlaySearch => ({
    room:
      typeof search.room === 'string' && /^[\w-]{1,64}$/.test(search.room)
        ? search.room
        : undefined,
  }),
  component: Play,
})

const GRID_COLS = 10
const GRID_ROWS = GRID_COLS * 2
const BAT_WIDTH = 2.5
const BAT_HEIGHT = 0.5

const STATUS_TEXT: Record<RoomStatus, string> = {
  connecting: 'Connecting…',
  waiting: 'Waiting for player 2 — share this link',
  playing: 'Opponent connected',
  closed: 'Disconnected',
}

function Play() {
  const { room } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const topBatRef = useRef<HTMLDivElement | null>(null)
  const bottomBatRef = useRef<HTMLDivElement | null>(null)
  const ballRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!room) {
      navigate({
        search: { room: crypto.randomUUID().slice(0, 8) },
        replace: true,
      })
    }
  }, [room, navigate])

  // Both players see themselves at the bottom, so the opponent is mirrored
  const onOpponentMove = useCallback((offset: number) => {
    if (topBatRef.current) setBatOffset(topBatRef.current, -offset)
  }, [])

  const onBallMove = useCallback(({ x, y }: BallPosition) => {
    if (ballRef.current) setBallPosition(ballRef.current, { x: -x, y: -y })
  }, [])

  const { status, player, sendMove, sendBall } = useGameRoom({
    roomId: room,
    onOpponentMove,
    onBallMove,
  })

  useBatControls({ batRef: bottomBatRef, onMove: sendMove })

  // Player 0 runs the ball and sends its position to player 1
  useBallMovement({
    ballRef,
    topBatRef,
    bottomBatRef,
    active: status === 'playing' && player === 0,
    onMove: sendBall,
  })

  return (
    <main className="h-dvh flex flex-col items-center justify-center gap-2">
      <p className="text-green-500 text-sm font-mono">{STATUS_TEXT[status]}</p>
      <section
        className="game-screen mx-auto my-auto outline outline-green-500 relative"
        style={
          {
            '--grid-cols': GRID_COLS,
            '--grid-rows': GRID_ROWS,
            '--bat-width': BAT_WIDTH,
            '--bat-height': BAT_HEIGHT,
          } as CSSProperties
        }
      >
        <div className="grid size-full grid-cols-[repeat(var(--grid-cols),minmax(0,1fr))] grid-rows-[repeat(var(--grid-rows),minmax(0,1fr))]">
          {Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => (
            <div key={i} className="border border-green-500/20" />
          ))}
        </div>
        <div
          ref={topBatRef}
          data-id="top-bat"
          className="bg-green-500 absolute top-0 w-[calc(100%/var(--grid-cols)*var(--bat-width))] h-[calc(100%/var(--grid-rows)*var(--bat-height))] left-1/2 -translate-x-1/2 rounded-full will-change-transform"
        />
        <div
          ref={bottomBatRef}
          data-id="bottom-bat"
          className="bg-green-500 absolute bottom-0 w-[calc(100%/var(--grid-cols)*var(--bat-width))] h-[calc(100%/var(--grid-rows)*var(--bat-height))] left-1/2 -translate-x-1/2 rounded-full will-change-transform"
        />
        <div
          ref={ballRef}
          data-id="ball"
          className="h-[calc(100%/var(--grid-rows)*var(--bat-height))] aspect-square bg-green-500 absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 rounded-full"
        />
      </section>
    </main>
  )
}
