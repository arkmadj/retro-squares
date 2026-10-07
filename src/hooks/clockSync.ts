import type { ClientMessage } from '#/server/messages'

type ClockSample = { rtt: number; offset: number }

const PING_INTERVAL = 1000
// Once the clock has a full set of samples, slower pings let the server hibernate
const STABLE_PING_INTERVAL = 5000
const CLOCK_SAMPLES = 8
// Pings sent back to back after connecting, so the clock is accurate quickly
const CLOCK_BURST = 6

type ClockSyncOptions = {
  sendPing: (message: Extract<ClientMessage, { type: 'ping' }>) => void
  // Receives the server clock minus performance.now(), in milliseconds
  setOffset: (offset: number) => void
}

export type ClockSync = ReturnType<typeof createClockSync>

export const createClockSync = ({ sendPing, setOffset }: ClockSyncOptions) => {
  let samples: ClockSample[] = []
  // Pings left in the current burst; each pong sends the next one
  let burst = 0
  let pingTimer: ReturnType<typeof setTimeout> | undefined

  // The median round trip lets the server allow for slow moments when
  // scheduling a round's start
  const typicalRtt = () => {
    if (samples.length === 0) return
    const rtts = samples.map((sample) => sample.rtt).sort((a, b) => a - b)
    return rtts[Math.floor(rtts.length / 2)]
  }

  const ping = () =>
    sendPing({ type: 'ping', t: performance.now(), rtt: typicalRtt() })

  const schedulePing = () => {
    const delay =
      samples.length < CLOCK_SAMPLES ? PING_INTERVAL : STABLE_PING_INTERVAL
    pingTimer = setTimeout(() => {
      ping()
      schedulePing()
    }, delay)
  }

  return {
    start: schedulePing,
    stop: () => clearTimeout(pingTimer),
    // Pings back to back after connecting, so the clock is accurate quickly
    sync: () => {
      burst = CLOCK_BURST
      ping()
    },
    // The welcome's time is a rough estimate until pongs arrive
    seed: (time: number) => {
      if (samples.length === 0) setOffset(time - performance.now())
    },
    pong: (message: { t: number; time: number }) => {
      // The lowest round trip gives the most accurate estimate
      const received = performance.now()
      const rtt = received - message.t
      samples = [
        ...samples,
        { rtt, offset: message.time + rtt / 2 - received },
      ].slice(-CLOCK_SAMPLES)
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
      setOffset(best.offset)
      if (burst > 1) {
        burst--
        ping()
      } else {
        burst = 0
      }
    },
    // A new server connection has a different round trip
    reset: () => {
      samples = []
    },
  }
}
