import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BallState,
  BatState,
  ClientMessage,
  Player,
  ServerMessage,
  Signal,
} from '#/server/messages'
import {
  ICE_CREDENTIAL_TTL,
  ICE_SERVERS_PATH,
  parseBall,
  parseBat,
  parseJson,
  ROOM_FULL_CODE,
  STUN_SERVERS,
} from '#/server/updates'

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

type ClockSample = { rtt: number; offset: number }

// Bat and ball updates, sent directly to the opponent when possible
type PeerMessage = Extract<ClientMessage, { type: 'bat' | 'ball' }>

const PING_INTERVAL = 1000
// Once the clock has a full set of samples, slower pings let the server hibernate
const STABLE_PING_INTERVAL = 5000
const CLOCK_SAMPLES = 8
// Pings sent back to back after connecting, so the clock is accurate quickly
const CLOCK_BURST = 6
// Reconnect delays double from the base up to the cap; the session ends after the last attempt
const RECONNECT_BASE_DELAY = 500
const RECONNECT_MAX_DELAY = 8000
const RECONNECT_ATTEMPTS = 8
// Milliseconds fetched ICE servers are reused, leaving most of the credentials' lifetime for the game
const ICE_SERVERS_REUSE = (ICE_CREDENTIAL_TTL * 1000) / 4

let iceServers: { servers: Promise<RTCIceServer[]>; t: number } | undefined

// TURN credentials come from the worker; without them only STUN is used
const loadIceServers = () => {
  const t = performance.now()
  if (iceServers && t - iceServers.t < ICE_SERVERS_REUSE) {
    return iceServers.servers
  }
  const entry = {
    t,
    servers: fetch(ICE_SERVERS_PATH)
      .then(async (response): Promise<RTCIceServer[]> => {
        if (!response.ok) throw new Error('ICE servers unavailable')
        const body: { iceServers: RTCIceServer[] } = await response.json()
        return body.iceServers
      })
      .catch(() => {
        // The next connection tries again
        if (iceServers === entry) iceServers = undefined
        return STUN_SERVERS
      }),
  }
  iceServers = entry
  return entry.servers
}

// The opponent's messages skip the server, so they get the server's checks here
const parsePeerMessage = (data: unknown): PeerMessage | undefined => {
  const message = parseJson(data)
  if (message?.type === 'bat') {
    const bat = parseBat(message)
    return bat && { type: 'bat', ...bat }
  }
  if (message?.type === 'ball') {
    const ball = parseBall(message)
    return ball && { type: 'ball', ...ball }
  }
}

const parseServerMessage = (data: unknown) =>
  parseJson(data) as ServerMessage | undefined

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
    let pingTimer: ReturnType<typeof setTimeout> | undefined
    let samples: ClockSample[] = []
    // Pings left in the current burst; each pong sends the next one
    let burst = 0
    let self: Player | null = null
    let peer: RTCPeerConnection | null = null
    // The peer's open data channel, kept while the connection briefly drops
    let peerChannel: RTCDataChannel | null = null
    // Bumped when the peer closes, so a connection still waiting for ICE servers is dropped
    let peerVersion = 0
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
      peerChannel = null
      setDirect(false)
      pendingCandidates = []
      peer?.close()
      peer = null
      peerVersion++
    }

    // Unordered but reliable, so a late update never holds up newer ones
    const setupChannel = (
      connection: RTCPeerConnection,
      dc: RTCDataChannel,
    ) => {
      dc.addEventListener('open', () => {
        if (peer !== connection) return
        peerChannel = dc
        if (connection.connectionState === 'disconnected') return
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
    const openPeer = async (initiator: boolean) => {
      // Candidates can arrive before the offer they belong to
      const queued = initiator ? [] : pendingCandidates
      closePeer()
      pendingCandidates = queued
      const version = peerVersion
      const servers = await loadIceServers()
      if (version !== peerVersion) return
      const connection = new RTCPeerConnection({ iceServers: servers })
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
      // The data channel can stay open long after the connection is lost
      connection.addEventListener('connectionstatechange', () => {
        if (peer !== connection) return
        switch (connection.connectionState) {
          case 'failed':
          case 'closed':
            closePeer()
            break
          case 'disconnected':
            // Updates go through the server until the connection recovers
            channel.current = null
            setDirect(false)
            break
          case 'connected':
            if (peerChannel?.readyState === 'open') {
              channel.current = peerChannel
              setDirect(true)
            }
            break
        }
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
      return connection
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

        // A newer connection may replace this one while it waits for ICE servers
        const connection =
          signal.type === 'offer' ? await openPeer(false) : peer
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
          // A stale candidate from an earlier connection is skipped
          await connection.addIceCandidate(candidate).catch(() => {})
        }
      } catch {
        // Updates keep going through the server
      }
    }

    // The median round trip lets the server allow for slow moments when
    // scheduling a round's start
    const typicalRtt = () => {
      if (samples.length === 0) return
      const rtts = samples.map((sample) => sample.rtt).sort((a, b) => a - b)
      return rtts[Math.floor(rtts.length / 2)]
    }

    const ping = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({
          type: 'ping',
          t: performance.now(),
          rtt: typicalRtt(),
        } satisfies ClientMessage),
      )
    }

    const schedulePing = () => {
      const delay =
        samples.length < CLOCK_SAMPLES ? PING_INTERVAL : STABLE_PING_INTERVAL
      pingTimer = setTimeout(() => {
        ping()
        schedulePing()
      }, delay)
    }

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
        burst = CLOCK_BURST
        ping()
      })
      current.addEventListener('message', (event) => {
        if (!active || current !== ws) return
        const message = parseServerMessage(event.data)
        if (message) handleMessage(message)
      })
      current.addEventListener('close', (event) => {
        if (!active || current !== ws) return
        endRound()
        closePeer()
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
          samples = []
          connect()
        }, delay)
      })
    }

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'welcome':
          if (samples.length === 0) {
            clockOffset.current = message.time - performance.now()
          }
          self = message.player
          attempts = 0
          endRound()
          setPlayer(message.player)
          setStatus('waiting')
          setReady(NOT_READY)
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
          if (burst > 1) {
            burst--
            ping()
          } else {
            burst = 0
          }
          break
        }
        case 'opponent':
          endRound()
          setStatus(message.connected ? 'paired' : 'waiting')
          setReady(NOT_READY)
          centreOpponentBat()
          if (message.connected && self === 0) {
            void openPeer(true)
          } else {
            closePeer()
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
          void handleSignal(message.signal)
          break
        case 'relocate': {
          // The lobby picked a room between both players; its clock is resampled
          const lobby = ws
          samples = []
          endRound()
          closePeer()
          path = `/ws/${roomId}/${message.hint}`
          connect()
          lobby.close()
          break
        }
      }
    }

    void loadIceServers()
    connect()
    schedulePing()

    return () => {
      active = false
      clearTimeout(retryTimer)
      clearTimeout(pingTimer)
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
    serve,
    direct,
    now,
    sendBat,
    sendBall,
    sendReady,
    sendMiss,
  }
}
