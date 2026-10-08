import type { ClientMessage, Signal } from '#/server/messages'
import {
  ICE_CREDENTIAL_TTL,
  ICE_SERVERS_PATH,
  parseBall,
  parseBat,
  parseJson,
  STUN_SERVERS,
} from '#/server/updates'

// Bat and ball updates, sent directly to the opponent when possible
export type PeerMessage = Extract<ClientMessage, { type: 'bat' | 'ball' }>

// Milliseconds fetched ICE servers are reused, leaving most of the credentials' lifetime for the game
const ICE_SERVERS_REUSE = (ICE_CREDENTIAL_TTL * 1000) / 4

// One data channel per update type, labelled with it. Both are unordered, so a
// late update never holds up newer ones. Ball updates are reliable; lost bat
// updates are dropped instead of retransmitted, and repeated instead.
const CHANNELS = {
  bat: { ordered: false, maxRetransmits: 0 },
  ball: { ordered: false },
} satisfies Record<PeerMessage['type'], RTCDataChannelInit>

type ChannelKind = keyof typeof CHANNELS

const CHANNEL_KINDS = Object.keys(CHANNELS) as ChannelKind[]

const isChannelKind = (label: string): label is ChannelKind =>
  Object.hasOwn(CHANNELS, label)

// Milliseconds between repeats of a bat update, since bats only send on a change
const BAT_REPEAT_GAPS = [20, 40, 90]

let iceServers: { servers: Promise<RTCIceServer[]>; t: number } | undefined

// TURN credentials come from the worker; without them only STUN is used
export const loadIceServers = () => {
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

type PeerLinkOptions = {
  sendSignal: (signal: Signal) => void
  onMessage: (message: PeerMessage) => void
  // Called when updates switch between the data channel and the server
  onDirect: (direct: boolean) => void
}

export type PeerLink = ReturnType<typeof createPeerLink>

export const createPeerLink = ({
  sendSignal,
  onMessage,
  onDirect,
}: PeerLinkOptions) => {
  let peer: RTCPeerConnection | null = null
  // Whether updates use the data channels; they go through the server otherwise
  let direct = false
  // The peer's open data channels, kept while the connection briefly drops
  let openChannels: Partial<Record<ChannelKind, RTCDataChannel>> = {}
  // Bumped when the peer closes, so a connection still waiting for ICE servers is dropped
  let peerVersion = 0
  // Candidates that arrived before the opponent's description
  let pendingCandidates: RTCIceCandidateInit[] = []
  let batRepeatTimer: ReturnType<typeof setTimeout> | undefined

  const setDirect = (next: boolean) => {
    direct = next
    onDirect(next)
  }

  const allOpen = () =>
    CHANNEL_KINDS.every((kind) => openChannels[kind]?.readyState === 'open')

  // Stops once a newer bat update is sent or the channel is no longer used
  const repeatBat = (dc: RTCDataChannel, data: string, index = 0) => {
    const gap = BAT_REPEAT_GAPS[index] as number | undefined
    if (gap === undefined) return
    batRepeatTimer = setTimeout(() => {
      if (!direct || openChannels.bat !== dc || dc.readyState !== 'open') {
        return
      }
      dc.send(data)
      repeatBat(dc, data, index + 1)
    }, gap)
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

  const closePeer = () => {
    clearTimeout(batRepeatTimer)
    openChannels = {}
    setDirect(false)
    pendingCandidates = []
    peer?.close()
    peer = null
    peerVersion++
  }

  const setupChannel = (
    connection: RTCPeerConnection,
    dc: RTCDataChannel,
    kind: ChannelKind,
  ) => {
    dc.addEventListener('open', () => {
      if (peer !== connection) return
      openChannels[kind] = dc
      if (connection.connectionState === 'disconnected') return
      if (allOpen()) setDirect(true)
    })
    dc.addEventListener('close', () => {
      if (openChannels[kind] !== dc) return
      delete openChannels[kind]
      if (direct) setDirect(false)
    })
    dc.addEventListener('message', (event) => {
      if (peer !== connection) return
      const message = parsePeerMessage(event.data)
      if (message) onMessage(message)
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
          setDirect(false)
          break
        case 'connected':
          if (allOpen()) setDirect(true)
          break
      }
    })
    if (initiator) {
      for (const kind of CHANNEL_KINDS) {
        setupChannel(
          connection,
          connection.createDataChannel(kind, CHANNELS[kind]),
          kind,
        )
      }
      connection
        .setLocalDescription()
        .then(() => {
          if (peer === connection) sendDescription(connection)
        })
        .catch(() => {
          // Updates keep going through the server
        })
    } else {
      connection.addEventListener('datachannel', ({ channel: dc }) => {
        if (isChannelKind(dc.label)) setupChannel(connection, dc, dc.label)
      })
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
      const connection = signal.type === 'offer' ? await openPeer(false) : peer
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

  return {
    offer: () => void openPeer(true),
    close: closePeer,
    handleSignal: (signal: Signal) => void handleSignal(signal),
    // False when the data channels are not in use, so the caller can use the server
    send: (message: PeerMessage) => {
      if (message.type === 'bat') clearTimeout(batRepeatTimer)
      const dc = openChannels[message.type]
      if (!direct || dc?.readyState !== 'open') return false
      const data = JSON.stringify(message)
      dc.send(data)
      if (message.type === 'bat') repeatBat(dc, data)
      return true
    },
  }
}
