import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BallState,
  BatState,
  ClientMessage,
  Player,
  ServerMessage,
} from '#/server/GameRoom'

export type RoomStatus =
  'connecting' | 'waiting' | 'paired' | 'playing' | 'closed'

export type ReadyState = { self: boolean; opponent: boolean }

const NOT_READY: ReadyState = { self: false, opponent: false }

type UseGameRoomOptions = {
  roomId: string | undefined
  onOpponentBat: (bat: BatState) => void
  onBall: (ball: BallState) => void
}

type ClockSample = { rtt: number; offset: number }

const PING_INTERVAL = 1000
const CLOCK_SAMPLES = 8

export const useGameRoom = ({
  roomId,
  onOpponentBat,
  onBall,
}: UseGameRoomOptions) => {
  const socket = useRef<WebSocket | null>(null)
  const onOpponentBatRef = useRef(onOpponentBat)
  const onBallRef = useRef(onBall)
  // Server clock minus performance.now(), in milliseconds
  const clockOffset = useRef(0)
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [player, setPlayer] = useState<Player | null>(null)
  const [ready, setReady] = useState<ReadyState>(NOT_READY)
  // Whether this player serves when the next round starts
  const [serving, setServing] = useState(false)

  useEffect(() => {
    onOpponentBatRef.current = onOpponentBat
  }, [onOpponentBat])

  useEffect(() => {
    onBallRef.current = onBall
  }, [onBall])

  // Current time on the server clock, shared by both players
  const now = useCallback(() => performance.now() + clockOffset.current, [])

  useEffect(() => {
    if (!roomId) return

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    setStatus('connecting')
    setReady(NOT_READY)

    let ws: WebSocket
    let samples: ClockSample[] = []
    let self: Player | null = null

    const ping = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({
          type: 'ping',
          t: performance.now(),
        } satisfies ClientMessage),
      )
    }

    const connect = (path: string) => {
      const current = new WebSocket(`${protocol}://${location.host}${path}`)
      ws = current
      socket.current = current
      current.addEventListener('open', ping)
      current.addEventListener('message', (event) => {
        if (current === ws) handleMessage(JSON.parse(event.data))
      })
      current.addEventListener('close', () => {
        if (current === ws) setStatus('closed')
      })
    }

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'welcome':
          if (samples.length === 0) {
            clockOffset.current = message.time - performance.now()
          }
          self = message.player
          setPlayer(message.player)
          setStatus('waiting')
          setReady(NOT_READY)
          // The host serves first in every new game
          setServing(message.player === 0)
          break
        case 'pong': {
          // The lowest round trip gives the most accurate estimate
          const received = performance.now()
          const rtt = received - message.t
          samples = [
            ...samples,
            { rtt, offset: message.time + rtt / 2 - received },
          ].slice(-CLOCK_SAMPLES)
          const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
          clockOffset.current = best.offset
          break
        }
        case 'opponent':
          setStatus(message.connected ? 'paired' : 'waiting')
          setReady(NOT_READY)
          setServing(self === 0)
          if (!message.connected) {
            onOpponentBatRef.current({ offset: 0, direction: 0, t: now() })
          }
          break
        case 'ready':
          setReady({ self: message.self, opponent: message.opponent })
          if (message.self && message.opponent) setStatus('playing')
          break
        case 'reset':
          setStatus('paired')
          setReady(NOT_READY)
          setServing(message.serve)
          onOpponentBatRef.current({ offset: 0, direction: 0, t: now() })
          break
        case 'bat': {
          const { type: _, ...bat } = message
          onOpponentBatRef.current(bat)
          break
        }
        case 'ball': {
          const { type: _, ...ball } = message
          onBallRef.current(ball)
          break
        }
        case 'relocate': {
          // The lobby picked a room between both players; its clock is resampled
          const lobby = ws
          samples = []
          const query = self === null ? '' : `?player=${self}`
          connect(`/ws/${roomId}/${message.hint}${query}`)
          lobby.close()
          break
        }
      }
    }

    connect(`/ws/${roomId}`)
    const pingInterval = setInterval(ping, PING_INTERVAL)

    return () => {
      clearInterval(pingInterval)
      socket.current = null
      ws.close()
    }
  }, [roomId, now])

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }, [])

  const sendBat = useCallback(
    (bat: Omit<BatState, 't'>) => send({ type: 'bat', ...bat, t: now() }),
    [send, now],
  )

  const sendBall = useCallback(
    (ball: BallState) => send({ type: 'ball', ...ball }),
    [send],
  )

  const sendReady = useCallback(() => send({ type: 'ready' }), [send])

  const sendMiss = useCallback(() => send({ type: 'miss' }), [send])

  return {
    status,
    player,
    ready,
    serving,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
  }
}
