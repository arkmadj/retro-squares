import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowButton } from '#/components/common/ArrowButton'
import { BUTTON_VARIANTS, Button } from '#/components/common/Button'
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
import { COUNTDOWN, WIN_SCORE } from '#/server/updates'

type PongSearch = { room?: string }

// Matches the room names the worker accepts in /ws/{room}
const ROOM_ID = /^[\w-]{1,64}$/

const isRoomId = (value: unknown): value is string =>
  typeof value === 'string' && ROOM_ID.test(value)

const createRoomId = () => crypto.randomUUID().slice(0, 8)

// Accepts a room code or a shared room link
// Codes are only made in lower case, so capitals typed by a player still match
// Codes never contain spaces or hyphens, so a code typed in two halves still matches
const parseRoomInput = (input: string) => {
  const text = input.replace(/[\s-]/g, '').toLowerCase()
  if (isRoomId(text)) return text
  try {
    const room = new URL(text, location.origin).searchParams.get('room')
    return isRoomId(room) ? room : undefined
  } catch {
    return undefined
  }
}

export const Route = createFileRoute('/pong')({
  validateSearch: (search: Record<string, unknown>): PongSearch => ({
    room: isRoomId(search.room) ? search.room.toLowerCase() : undefined,
  }),
  component: Pong,
})

const GRID_COLS = 10
const GRID_ROWS = GRID_COLS * 2
const BAT_WIDTH = 2.5
const BAT_HEIGHT = 0.5

const STATUS_TEXT: Record<RoomStatus, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Connection lost — reconnecting…',
  waiting: 'Waiting for a second player',
  paired: 'Opponent connected — press Ready to start',
  playing: 'Game on',
  full: 'This room already has two players',
  closed: 'Lost connection to the room',
}

// Whole seconds left until the serve moves, or 0 once it has
const useCountdown = (
  serve: BallState | null,
  active: boolean,
  now: () => number,
) => {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!active || !serve) return
    const start = serve.t
    let frame = requestAnimationFrame(tick)
    function tick() {
      const left = Math.ceil((start - now()) / 1000)
      setCount(Math.min(COUNTDOWN / 1000, Math.max(0, left)))
      if (left > 0) frame = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(frame)
  }, [serve, active, now])

  return active && serve ? count : 0
}

// Milliseconds the copy result stays on the button
const COPY_FEEDBACK_TIME = 2000

function CopyLinkButton() {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied('idle'), COPY_FEEDBACK_TIME)
  }

  return (
    <Button
      variant="primary"
      onClick={copy}
      aria-live="polite"
      className="text-sm px-4 py-2"
    >
      {copied === 'copied'
        ? 'Link copied'
        : copied === 'failed'
          ? 'Copy failed'
          : 'Copy room link'}
    </Button>
  )
}

const COPY_LABELS = {
  idle: 'Copy room code',
  copied: 'Room code copied',
  failed: 'Copy failed',
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied('idle'), COPY_FEEDBACK_TIME)
  }

  return (
    <Button
      onClick={copy}
      aria-label={COPY_LABELS[copied]}
      title={COPY_LABELS[copied]}
      className="p-1"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        {copied === 'copied' ? (
          <path d="M5 12l5 5L20 7" />
        ) : copied === 'failed' ? (
          <path d="M6 6l12 12M18 6L6 18" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" />
            <path d="M5 15V5h10" />
          </>
        )}
      </svg>
    </Button>
  )
}

// Milliseconds a mid-game Leave waits for the confirming press
const LEAVE_CONFIRM_TIME = 3000

type LeaveButtonProps = {
  // Leaving ends the game for the opponent, so it takes a second press
  confirm: boolean
  onLeave: () => void
  className?: string
}

function LeaveButton({ confirm, onLeave, className = '' }: LeaveButtonProps) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), LEAVE_CONFIRM_TIME)
    return () => clearTimeout(timer)
  }, [armed])

  return (
    <Button
      onClick={() => (confirm && !armed ? setArmed(true) : onLeave())}
      aria-live="polite"
      className={`text-sm px-4 ${className}`}
    >
      {armed ? 'Press again to leave' : 'Leave room'}
    </Button>
  )
}

type LobbyMenuProps = {
  open: boolean
  onEnter: (room: string) => void
}

function LobbyMenu({ open, onEnter }: LobbyMenuProps) {
  const [joining, setJoining] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const joinButton = useRef<HTMLButtonElement | null>(null)

  const join = (event: FormEvent) => {
    event.preventDefault()
    const room = parseRoomInput(code)
    if (!room) {
      setError(true)
      return
    }
    setJoining(false)
    setCode('')
    setError(false)
    onEnter(room)
  }

  const closeForm = () => {
    // The form stays mounted, so clear the code for the next join
    // The lobby buttons render first, so focus can return to Join room
    flushSync(() => {
      setJoining(false)
      setCode('')
      setError(false)
    })
    joinButton.current?.focus()
  }

  return (
    <GameMenu
      open={open}
      message={
        joining
          ? 'Enter the room code or paste the link your friend shared'
          : `Play a friend in real time. First to ${WIN_SCORE} points wins.`
      }
    >
      {joining ? (
        <form
          onSubmit={join}
          // The menu is a dialog, so Escape leaves the form like Back
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeForm()
          }}
          noValidate
          className="flex flex-col gap-2"
        >
          <label htmlFor="room-code" className="sr-only">
            Room code or link
          </label>
          <input
            id="room-code"
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={256}
            placeholder="e.g. 3f9a1c2b"
            value={code}
            aria-invalid={error}
            aria-describedby={error ? 'room-code-error' : undefined}
            onChange={(event) => {
              setCode(event.target.value)
              setError(false)
            }}
            className="bg-black px-3 py-2 text-sm text-center font-mono text-green-500 tracking-widest outline outline-green-500 placeholder:text-green-500/40 focus:outline-2 aria-invalid:outline-red-500"
          />
          {error && (
            <p
              id="room-code-error"
              role="alert"
              className="text-xs text-red-500"
            >
              That isn't a room code or room link
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={!code.trim()}
            className="text-sm px-4 py-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            Join room
          </Button>
          <Button onClick={closeForm} className="text-sm px-4 py-2">
            Back
          </Button>
        </form>
      ) : (
        <>
          <Button
            variant="primary"
            onClick={() => onEnter(createRoomId())}
            className="text-sm px-4 py-2"
          >
            Create room
          </Button>
          <Button
            ref={joinButton}
            onClick={() => setJoining(true)}
            className="text-sm px-4 py-2"
          >
            Join room
          </Button>
          <Link
            to="/"
            className={`font-mono text-sm px-4 py-2 ${BUTTON_VARIANTS.secondary}`}
          >
            Home
          </Link>
        </>
      )}
    </GameMenu>
  )
}

function Pong() {
  const { room } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const topBatRef = useRef<HTMLDivElement | null>(null)
  const bottomBatRef = useRef<HTMLDivElement | null>(null)
  const ballRef = useRef<HTMLDivElement | null>(null)
  const opponentBat = useRef<BatState | null>(null)
  const ballState = useRef<LocalBallState | null>(null)

  // Each room is its own history entry, so Back returns to the lobby
  // A refused room is replaced, so Back doesn't return to it
  const enterRoom = useCallback(
    (next: string, replace = false) =>
      navigate({ search: { room: next }, replace }),
    [navigate],
  )
  const leaveRoom = useCallback(() => navigate({ search: {} }), [navigate])

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
    score,
    direct,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
    retry,
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

  const countdown = useCountdown(serve, status === 'playing', now)
  const winner =
    score.self >= WIN_SCORE
      ? 'self'
      : score.opponent >= WIN_SCORE
        ? 'opponent'
        : null
  const gameOver = status === 'paired' && winner !== null
  const gameInProgress =
    status === 'paired' && !gameOver && score.self + score.opponent > 0

  const inRoom = room !== undefined
  // Leaving now would end a game the opponent is part of
  const confirmLeave = status === 'playing' || gameInProgress

  return (
    <main className="h-svh flex flex-col items-center justify-center gap-2 max-md:py-2">
      <div className="my-auto flex flex-col gap-2">
        <header className="game-width flex h-8 items-center justify-between gap-2 font-mono text-sm text-green-500">
          {inRoom ? (
            <>
              <LeaveButton
                confirm={confirmLeave}
                onLeave={leaveRoom}
                className="py-1"
              />
              <span className="min-w-0 truncate text-green-500/70">
                Room <span className="font-bold text-green-500">{room}</span>
              </span>
            </>
          ) : (
            <>
              <Link
                to="/"
                className="px-2 py-1 hover:bg-green-500 hover:text-black"
              >
                ◀ Home
              </Link>
              <span className="uppercase tracking-widest text-green-500/70">
                Pong
              </span>
            </>
          )}
        </header>
        <section
          className="game-screen mx-auto outline outline-green-500 relative overflow-hidden"
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
          <div
            aria-label={`Score: you ${score.self}, opponent ${score.opponent}`}
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-4 font-mono text-2xl font-bold text-green-500/60"
          >
            <span>{score.opponent}</span>
            <span>{score.self}</span>
          </div>
          <LobbyMenu open={!inRoom} onEnter={enterRoom} />
          <GameMenu
            open={inRoom && status !== 'playing'}
            title={
              gameOver
                ? winner === 'self'
                  ? 'You win'
                  : 'You lose'
                : undefined
            }
            waiting={
              status === 'connecting' ||
              status === 'reconnecting' ||
              (status === 'paired' && ready.self)
            }
            message={
              <>
                {status === 'paired' && ready.self
                  ? 'Waiting for opponent to be ready'
                  : gameOver
                    ? `Final score ${score.self}–${score.opponent} — press Rematch to play again`
                    : STATUS_TEXT[status]}
                {status === 'waiting' && (
                  <span className="flex flex-col items-center gap-1 pt-2">
                    <span className="text-xs uppercase tracking-widest text-green-500/70">
                      Room code
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="game-menu-glow break-all text-2xl font-bold tracking-widest">
                        {room}
                      </span>
                      {room && <CopyCodeButton code={room} />}
                    </span>
                    <span className="text-xs text-green-500/70">
                      Share the link or code with a friend
                    </span>
                  </span>
                )}
                {gameInProgress && (
                  <span>
                    Score: you {score.self} – {score.opponent} opponent
                  </span>
                )}
                {status === 'paired' && !gameOver && (
                  <span>First to {WIN_SCORE} points wins</span>
                )}
                {status === 'paired' && !ready.self && ready.opponent && (
                  <span className="game-menu-glow font-bold">
                    Opponent is ready
                  </span>
                )}
              </>
            }
          >
            {status === 'waiting' && <CopyLinkButton />}
            {status === 'paired' && !ready.self && (
              <Button
                variant="primary"
                onClick={sendReady}
                className="text-sm px-4 py-2"
              >
                {gameOver ? 'Rematch' : 'Ready'}
              </Button>
            )}
            {status === 'full' && (
              <Button
                variant="primary"
                onClick={() => enterRoom(createRoomId(), true)}
                className="text-sm px-4 py-2"
              >
                Create new room
              </Button>
            )}
            {status === 'closed' && (
              <Button
                variant="primary"
                onClick={retry}
                className="text-sm px-4 py-2"
              >
                Try again
              </Button>
            )}
            {status === 'full' || status === 'closed' ? (
              <Button onClick={leaveRoom} className="text-sm px-4 py-2">
                Back to menu
              </Button>
            ) : (
              <LeaveButton
                confirm={confirmLeave}
                onLeave={leaveRoom}
                className="py-2"
              />
            )}
          </GameMenu>
          <GameMenu
            open={status === 'playing' && countdown > 0}
            message="Get ready"
          >
            <p aria-live="assertive" className="text-6xl font-bold">
              {countdown}
            </p>
          </GameMenu>
        </section>
      </div>
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
