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
  // Open data channel to the opponent; updates go through the server without one
  let channel: RTCDataChannel | null = null
  // The peer's open data channel, kept while the connection briefly drops
  let peerChannel: RTCDataChannel | null = null
  // Bumped when the peer closes, so a connection still waiting for ICE servers is dropped
  let peerVersion = 0
  // Candidates that arrived before the opponent's description
  let pendingCandidates: RTCIceCandidateInit[] = []

  const setChannel = (dc: RTCDataChannel | null) => {
    channel = dc
    onDirect(dc !== null)
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
    peerChannel = null
    setChannel(null)
    pendingCandidates = []
    peer?.close()
    peer = null
    peerVersion++
  }

  // Unordered but reliable, so a late update never holds up newer ones
  const setupChannel = (connection: RTCPeerConnection, dc: RTCDataChannel) => {
    dc.addEventListener('open', () => {
      if (peer !== connection) return
      peerChannel = dc
      if (connection.connectionState === 'disconnected') return
      setChannel(dc)
    })
    dc.addEventListener('close', () => {
      if (channel !== dc) return
      setChannel(null)
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
          setChannel(null)
          break
        case 'connected':
          if (peerChannel?.readyState === 'open') setChannel(peerChannel)
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
    // False when there is no open data channel, so the caller can use the server
    send: (message: PeerMessage) => {
      if (channel?.readyState !== 'open') return false
      channel.send(JSON.stringify(message))
      return true
    },
  }
}
