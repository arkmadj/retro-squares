import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BallState,
  BatState,
  ClientMessage,
  Player,
  ServerMessage,
  Signal,
} from '#/server/GameRoom'
import { parseBall, parseBat } from '#/server/updates'

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

// Bat and ball updates, sent directly to the opponent when possible
type PeerMessage = Extract<ClientMessage, { type: 'bat' | 'ball' }>

const PING_INTERVAL = 1000
const CLOCK_SAMPLES = 8
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

// The opponent's messages skip the server, so they get the server's checks here
const parsePeerMessage = (data: unknown): PeerMessage | undefined => {
  if (typeof data !== 'string') return
  let message: Record<string, unknown> | null
  try {
    message = JSON.parse(data)
  } catch {
    return
  }
  if (message?.type === 'bat') {
    const bat = parseBat(message)
    return bat && { type: 'bat', ...bat }
  }
  if (message?.type === 'ball') {
    const ball = parseBall(message)
    return ball && { type: 'ball', ...ball }
  }
}

export const useGameRoom = ({
  roomId,
  onOpponentBat,
  onBall,
}: UseGameRoomOptions) => {
  const socket = useRef<WebSocket | null>(null)
  // Open data channel to the opponent; updates go through the server without one
  const channel = useRef<RTCDataChannel | null>(null)
  const onOpponentBatRef = useRef(onOpponentBat)
  const onBallRef = useRef(onBall)
  // Server clock minus performance.now(), in milliseconds
  const clockOffset = useRef(0)
  // Whether this player has pressed Ready for the next round
  const readySent = useRef(false)
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [player, setPlayer] = useState<Player | null>(null)
  const [ready, setReady] = useState<ReadyState>(NOT_READY)
  // Whether this player serves when the next round starts
  const [serving, setServing] = useState(false)
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
    let samples: ClockSample[] = []
    let self: Player | null = null
    let peer: RTCPeerConnection | null = null
    // Candidates that arrived before the opponent's description
    let pendingCandidates: RTCIceCandidateInit[] = []
    // Updates from before these times belong to an earlier round or bat movement
    let roundStart = 0
    let lastBatTime = 0
    // Like the server, direct updates only count while both players are ready
    let inProgress = false
    // Direct updates can beat the server's start message, so they wait for it
    let early: { bat?: BatState; ball?: BallState } = {}

    const sendSignal = (signal: Signal) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({ type: 'signal', signal } satisfies ClientMessage),
      )
    }

    const sendDescription = (connection: RTCPeerConnection) => {
      const description = connection.localDescription
      if (description?.type !== 'offer' && description?.type !== 'answer') {
        return
      }
      sendSignal({
        kind: 'description',
        type: description.type,
        sdp: description.sdp,
      })
    }

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

    const closePeer = () => {
      channel.current = null
      setDirect(false)
      pendingCandidates = []
      peer?.close()
      peer = null
    }

    // Unordered but reliable, so a late update never holds up newer ones
    const setupChannel = (
      connection: RTCPeerConnection,
      dc: RTCDataChannel,
    ) => {
      dc.addEventListener('open', () => {
        if (peer !== connection) return
        channel.current = dc
        setDirect(true)
      })
      dc.addEventListener('close', () => {
        if (channel.current !== dc) return
        channel.current = null
        setDirect(false)
      })
      dc.addEventListener('message', (event) => {
        if (peer !== connection) return
        const message = parsePeerMessage(event.data)
        if (message) receiveDirect(message)
      })
    }

    // The host makes the offer so both players never offer at once
    const openPeer = (initiator: boolean) => {
      closePeer()
      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peer = connection
      connection.addEventListener('icecandidate', ({ candidate }) => {
        if (peer !== connection || !candidate) return
        sendSignal({
          kind: 'candidate',
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        })
      })
      if (initiator) {
        setupChannel(
          connection,
          connection.createDataChannel('game', { ordered: false }),
        )
        connection
          .setLocalDescription()
          .then(() => {
            if (peer === connection) sendDescription(connection)
          })
          .catch(() => {
            // Updates keep going through the server
          })
      } else {
        connection.addEventListener('datachannel', ({ channel: dc }) =>
          setupChannel(connection, dc),
        )
      }
    }

    const handleSignal = async (signal: Signal) => {
      try {
        if (signal.kind === 'candidate') {
          const candidate: RTCIceCandidateInit = {
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
          }
          if (peer?.remoteDescription) {
            await peer.addIceCandidate(candidate)
          } else {
            pendingCandidates.push(candidate)
          }
          return
        }

        if (signal.type === 'offer') openPeer(false)
        const connection = peer
        if (!connection) return
        await connection.setRemoteDescription({
          type: signal.type,
          sdp: signal.sdp,
        })
        if (signal.type === 'offer') {
          await connection.setLocalDescription()
          if (peer !== connection) return
          sendDescription(connection)
        }
        for (const candidate of pendingCandidates.splice(0)) {
          if (peer !== connection) return
          await connection.addIceCandidate(candidate)
        }
      } catch {
        // Updates keep going through the server
      }
    }

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
        if (current !== ws) return
        endRound()
        closePeer()
        setStatus('closed')
      })
    }

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'welcome':
          if (samples.length === 0) {
            clockOffset.current = message.time - performance.now()
          }
          self = message.player
          endRound()
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
          endRound()
          setStatus(message.connected ? 'paired' : 'waiting')
          setReady(NOT_READY)
          setServing(self === 0)
          centreOpponentBat()
          if (message.connected && self === 0) {
            openPeer(true)
          } else {
            closePeer()
          }
          break
        case 'ready':
          setReady({ self: message.self, opponent: message.opponent })
          if (message.self && message.opponent) {
            startRound()
            setStatus('playing')
          }
          break
        case 'reset':
          endRound()
          setStatus('paired')
          setReady(NOT_READY)
          setServing(message.serve)
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
          void handleSignal(message.signal)
          break
        case 'relocate': {
          // The lobby picked a room between both players; its clock is resampled
          const lobby = ws
          samples = []
          endRound()
          closePeer()
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
      closePeer()
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
      const dc = channel.current
      if (dc?.readyState === 'open') {
        dc.send(JSON.stringify(message))
      } else {
        send(message)
      }
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
    serving,
    direct,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
  }
}
