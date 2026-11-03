import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '#/components/common/Button'

const STORAGE_KEY = 'sound'
const VOLUME = 0.04
const BOUNCE_HZ = 459 // The original Pong's paddle hit
const START_HZ = [440, 587, 880]
const START_NOTE_SECONDS = 0.07
const CLICK_HZ = 880
const CLICK_SECONDS = 0.03

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let savedOn: boolean | undefined

const isSoundOn = () => {
  if (savedOn === undefined) {
    // Storage can be blocked, and sound then starts off like a first visit
    try {
      savedOn = localStorage.getItem(STORAGE_KEY) === 'on'
    } catch {
      savedOn = false
    }
  }
  return savedOn
}

const setSoundOn = (on: boolean) => {
  savedOn = on
  // Storage can be blocked, and the switch still works until the page reloads
  try {
    if (on) localStorage.setItem(STORAGE_KEY, 'on')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
  listeners.forEach((listener) => listener())
}

let audio: AudioContext | undefined

// Browsers only start audio during a click or key press, so call this from one
const unlockAudio = async () => {
  audio ??= new AudioContext()
  await audio.resume()
  return audio
}

const playTone = (
  context: AudioContext,
  frequency: number,
  delay: number,
  duration: number,
) => {
  const start = context.currentTime + delay
  const oscillator = new OscillatorNode(context, {
    type: 'square',
    frequency,
  })
  const gain = new GainNode(context, { gain: VOLUME })
  // Fading out avoids the click of a wave cut off mid-cycle
  gain.gain.setValueAtTime(VOLUME, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + duration)
}

// A suspended context would queue these up and play them all at once on the first click
export const playBounce = () => {
  if (isSoundOn() && audio?.state === 'running') {
    playTone(audio, BOUNCE_HZ, 0, 0.05)
  }
}

export const playStart = () => {
  if (!isSoundOn()) return
  void unlockAudio().then((context) => {
    START_HZ.forEach((frequency, i) => {
      playTone(context, frequency, i * START_NOTE_SECONDS, START_NOTE_SECONDS)
    })
  })
}

const playClickTone = () => {
  void unlockAudio().then((context) => {
    playTone(context, CLICK_HZ, 0, CLICK_SECONDS)
  })
}

export const playClick = () => {
  if (isSoundOn()) playClickTone()
}

export function SoundToggle({ className = '' }: { className?: string }) {
  // The server can't see the saved choice, so it always renders the default
  const on = useSyncExternalStore(subscribe, isSoundOn, () => false)

  // A saved choice has no click to start the audio, so the visitor's next one does
  useEffect(() => {
    if (!on) return
    const unlock = () => void unlockAudio()
    window.addEventListener('click', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('click', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [on])

  return (
    <Button
      role="switch"
      aria-checked={on}
      aria-label="Sound"
      title="Sound"
      onClick={() => {
        setSoundOn(!on)
        // Heard in both directions, so turning sound off is confirmed too
        playClickTone()
      }}
      className={`p-1.5 ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path d="M4 9v6h4l5 4V5L8 9H4Z" />
        {on ? (
          <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />
        ) : (
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        )}
      </svg>
    </Button>
  )
}
