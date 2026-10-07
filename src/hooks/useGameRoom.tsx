import { useCallback, useEffect, useRef, useState } from 'react'
import { createClockSync } from '#/hooks/clockSync'
import { createPeerLink, loadIceServers } from '#/hooks/peerLink'
import type { PeerLink, PeerMessage } from '#/hooks/peerLink'
import type {
  BallState,
  BatState,
  ClientMessage,
  Player,
  ServerMessage,
} from '#/server/messages'
import { parseJson, ROOM_FULL_CODE } from '#/server/updates'

export type RoomStatus =
  | 'connecting'
  | 'reconnecting'
  | 'waiting'
  | 'paired'
  | 'playing'
  | 'full'
  | 'closed'

export type ReadyState = { self: boolean; opponent: boolean }

const NOT_READY: ReadyState = { self: false, opponent: false }

type UseGameRoomOptions = {
  roomId: string | undefined
  onOpponentBat: (bat: BatState) => void
  onBall: (ball: BallState) => void
}

// Reconnect delays double from the base up to the cap; the session ends after the last attempt
const RECONNECT_BASE_DELAY = 500
const RECONNECT_MAX_DELAY = 8000
const RECONNECT_ATTEMPTS = 8

const parseServerMessage = (data: unknown) =>
  parseJson(data) as ServerMessage | undefined

export const useGameRoom = ({
  roomId,
  onOpponentBat,
  onBall,
}: UseGameRoomOptions) => {
  const socket = useRef<WebSocket | null>(null)
  // Direct connection to the opponent for bat and ball updates
  const peerLink = useRef<PeerLink | null>(null)
  const onOpponentBatRef = useRef(onOpponentBat)
  const onBallRef = useRef(onBall)
  // Server clock minus performance.now(), in milliseconds
  const clockOffset = useRef(0)
  // Whether this player has pressed Ready for the next round
  const readySent = useRef(false)
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [player, setPlayer] = useState<Player | null>(null)
  const [ready, setReady] = useState<ReadyState>(NOT_READY)
  // The server's serve for the current round, in this player's view
  const [serve, setServe] = useState<BallState | null>(null)
  // Whether bat and ball updates go directly to the opponent
  const [direct, setDirect] = useState(false)

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
    // Cleared on cleanup so this effect's sockets stop touching shared state
    let active = true
    // The lobby, or the room it placed the game in; reconnects go back here
    let path = `/ws/${roomId}`
    // Failed reconnects since the server last welcomed this player
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let self: Player | null = null
    // Updates from before these times belong to an earlier round or bat movement
    let roundStart = 0
    let lastBatTime = 0
    // Like the server, direct updates only count while both players are ready
    let inProgress = false
    // Direct updates can beat the server's start message, so they wait for it
    let early: { bat?: BatState; ball?: BallState } = {}

    const sendMessage = (message: ClientMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(message))
    }

    const clock = createClockSync({
      sendPing: sendMessage,
      setOffset: (offset) => {
        clockOffset.current = offset
      },
    })

    const receiveBat = (bat: BatState) => {
      // Direct updates can arrive out of order
      if (bat.t < lastBatTime) return
      lastBatTime = bat.t
      onOpponentBatRef.current(bat)
    }

    const receiveBall = (ball: BallState) => {
      if (ball.t < roundStart) return
      onBallRef.current(ball)
    }

    const receiveDirect = (message: PeerMessage) => {
      const { type, ...update } = message
      if (inProgress) {
        if (type === 'bat') receiveBat(update as BatState)
        else receiveBall(update as BallState)
      } else if (readySent.current) {
        if (type === 'bat') {
          const bat = update as BatState
          if (!early.bat || bat.t >= early.bat.t) early.bat = bat
        } else {
          const ball = update as BallState
          if (!early.ball || ball.seq > early.ball.seq) early.ball = ball
        }
      }
    }

    const startRound = () => {
      inProgress = true
      const { bat, ball } = early
      early = {}
      if (bat) receiveBat(bat)
      if (ball) receiveBall(ball)
    }

    const endRound = () => {
      inProgress = false
      readySent.current = false
      early = {}
    }

    const centreOpponentBat = () => {
      const t = now()
      roundStart = t
      lastBatTime = t
      onOpponentBatRef.current({ offset: 0, direction: 0, t })
    }

    const peer = createPeerLink({
      sendSignal: (signal) => sendMessage({ type: 'signal', signal }),
      onMessage: receiveDirect,
      onDirect: setDirect,
    })
    peerLink.current = peer

    // Players keep their number when reconnecting, so the server gives back the same seat
    const connect = () => {
      const query = self === null ? '' : `?player=${self}`
      const current = new WebSocket(
        `${protocol}://${location.host}${path}${query}`,
      )
      ws = current
      socket.current = current
      current.addEventListener('open', () => {
        if (!active || current !== ws) return
        clock.sync()
      })
      current.addEventListener('message', (event) => {
        if (!active || current !== ws) return
        const message = parseServerMessage(event.data)
        if (message) handleMessage(message)
      })
      current.addEventListener('close', (event) => {
        if (!active || current !== ws) return
        endRound()
        peer.close()
        const full = event.code === ROOM_FULL_CODE
        // A first join to a full room is final; on a reconnect the server may still hold the old seat
        if ((full && self === null) || attempts >= RECONNECT_ATTEMPTS) {
          setStatus(full ? 'full' : 'closed')
          return
        }
        const delay = Math.min(
          RECONNECT_MAX_DELAY,
          RECONNECT_BASE_DELAY * 2 ** attempts,
        )
        attempts++
        setStatus('reconnecting')
        setReady(NOT_READY)
        retryTimer = setTimeout(() => {
          if (!active) return
          clock.reset()
          connect()
        }, delay)
      })
    }

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'welcome':
          clock.seed(message.time)
          self = message.player
          attempts = 0
          endRound()
          setPlayer(message.player)
          setStatus('waiting')
          setReady(NOT_READY)
          break
        case 'pong':
          clock.pong(message)
          break
        case 'opponent':
          endRound()
          setStatus(message.connected ? 'paired' : 'waiting')
          setReady(NOT_READY)
          centreOpponentBat()
          if (message.connected && self === 0) {
            peer.offer()
          } else {
            peer.close()
          }
          break
        case 'ready':
          setReady({ self: message.self, opponent: message.opponent })
          break
        case 'start':
          // The ball waits at the centre until the server's start time
          startRound()
          setServe(message.ball)
          setStatus('playing')
          break
        case 'reset':
          endRound()
          setStatus('paired')
          setReady(NOT_READY)
          centreOpponentBat()
          break
        case 'bat': {
          const { type: _, ...bat } = message
          receiveBat(bat)
          break
        }
        case 'ball': {
          const { type: _, ...ball } = message
          receiveBall(ball)
          break
        }
        case 'signal':
          peer.handleSignal(message.signal)
          break
        case 'relocate': {
          // The lobby picked a room between both players; its clock is resampled
          const lobby = ws
          clock.reset()
          endRound()
          peer.close()
          path = `/ws/${roomId}/${message.hint}`
          connect()
          lobby.close()
          break
        }
      }
    }

    void loadIceServers()
    connect()
    clock.start()

    return () => {
      active = false
      clearTimeout(retryTimer)
      clock.stop()
      peer.close()
      peerLink.current = null
      socket.current = null
      ws.close()
    }
  }, [roomId, now])

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }, [])

  const sendToOpponent = useCallback(
    (message: PeerMessage) => {
      if (!peerLink.current?.send(message)) send(message)
    },
    [send],
  )

  const sendBat = useCallback(
    (bat: Omit<BatState, 't'>) =>
      sendToOpponent({ type: 'bat', ...bat, t: now() }),
    [sendToOpponent, now],
  )

  const sendBall = useCallback(
    (ball: BallState) => sendToOpponent({ type: 'ball', ...ball }),
    [sendToOpponent],
  )

  const sendReady = useCallback(() => {
    readySent.current = true
    send({ type: 'ready' })
  }, [send])

  const sendMiss = useCallback(() => send({ type: 'miss' }), [send])

  return {
    status,
    player,
    ready,
    serve,
    direct,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
  }
}
