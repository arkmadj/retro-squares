import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowButton } from '#/components/common/ArrowButton'
import { Button } from '#/components/common/Button'
import { GameMenu } from '#/components/GameMenu'
import {
  mirrorBall,
  receiveBall,
  useBallMovement,
} from '#/hooks/useBallMovement'
import type { LocalBallState } from '#/hooks/useBallMovement'
import { useBatControls, useRemoteBat } from '#/hooks/useBatControls'
import { useGameRoom } from '#/hooks/useGameRoom'
import type { RoomStatus } from '#/hooks/useGameRoom'
import type { BallState, BatState, Direction } from '#/server/messages'

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
  reconnecting: 'Connection lost — reconnecting…',
  waiting: 'Waiting for player 2 — share this link',
  paired: 'Opponent connected — press Ready to start',
  playing: 'Game on',
  full: 'Room full',
  closed: 'Disconnected',
}

function Play() {
  const { room } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const topBatRef = useRef<HTMLDivElement | null>(null)
  const bottomBatRef = useRef<HTMLDivElement | null>(null)
  const ballRef = useRef<HTMLDivElement | null>(null)
  const opponentBat = useRef<BatState | null>(null)
  const ballState = useRef<LocalBallState | null>(null)

  useEffect(() => {
    if (!room) {
      navigate({
        search: { room: crypto.randomUUID().slice(0, 8) },
        replace: true,
      })
    }
  }, [room, navigate])

  // Both players see themselves at the bottom, so the opponent is mirrored
  const onOpponentBat = useCallback(({ offset, direction, t }: BatState) => {
    opponentBat.current = {
      offset: -offset,
      direction: -direction as Direction,
      t,
    }
  }, [])

  const onBall = useCallback((ball: BallState) => {
    receiveBall(ballState, mirrorBall(ball))
  }, [])

  const {
    status,
    ready,
    serve,
    direct,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
  } = useGameRoom({
    roomId: room,
    onOpponentBat,
    onBall,
  })

  const { moveLeft, moveRight } = useBatControls({
    batRef: bottomBatRef,
    onChange: sendBat,
    enabled: status === 'playing',
  })
  useRemoteBat({ batRef: topBatRef, batState: opponentBat, now })

  useBallMovement({
    ballRef,
    topBatRef,
    bottomBatRef,
    ballState,
    active: status === 'playing',
    serve,
    now,
    onEvent: sendBall,
    onMiss: sendMiss,
  })

  return (
    <main className="h-svh flex flex-col items-center justify-center gap-2 max-md:py-2">
      <section
        className="game-screen mx-auto my-auto outline outline-green-500 relative overflow-hidden"
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
        {status !== 'playing' && (
          <GameMenu
            waiting={
              status === 'connecting' ||
              status === 'reconnecting' ||
              status === 'waiting' ||
              (status === 'paired' && ready.self)
            }
            message={
              <>
                {status === 'paired' && ready.self
                  ? 'Waiting for opponent to be ready'
                  : STATUS_TEXT[status]}
              </>
            }
          >
            {status === 'paired' && !ready.self && (
              <Button onClick={sendReady} className="text-sm px-4 py-1">
                Ready{ready.opponent && ' (opponent is ready)'}
              </Button>
            )}
          </GameMenu>
        )}
      </section>
      <div className="hidden pointer-coarse:flex justify-between game-width">
        <ArrowButton label="Move left" onPress={moveLeft}>
          ←
        </ArrowButton>
        <ArrowButton label="Move right" onPress={moveRight}>
          →
        </ArrowButton>
      </div>
    </main>
  )
}
