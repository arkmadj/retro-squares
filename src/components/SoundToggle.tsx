import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '#/components/common/Button'

const STORAGE_KEY = 'sound'
const VOLUME = 0.04
const BOUNCE_HZ = 459 // The original Pong's paddle hit
const START_HZ = [440, 587, 880]
const START_NOTE_SECONDS = 0.07
const CLICK_HZ = 880
const CLICK_SECONDS = 0.03

const MUSIC_VOLUME = 0.6
const MUSIC_STEPS_PER_BAR = 8
const MUSIC_BASS_EVERY_STEPS = 4
// Notes are queued ahead of time, because timers are too uneven to play them on the beat
const MUSIC_LOOKAHEAD_SECONDS = 0.2
const MUSIC_TICK_MS = 50

// Notes are MIDI numbers, with one bar per line. Null is a rest. The bass has one note a bar.
type Tune = {
  stepSeconds: number
  lead: (number | null)[]
  bass: number[]
}

// Over the chords Am, F, C and G
export const HOME_TUNE: Tune = {
  stepSeconds: 0.25,
  // prettier-ignore
  lead: [
    69, 72, 76, null, 81, 76, 72, 76,
    69, 72, 77, null, 81, 77, 72, 77,
    67, 72, 76, null, 79, 76, 72, 76,
    67, 71, 74, null, 79, 74, 71, 74,
  ],
  bass: [57, 53, 60, 55],
}

// Faster and lower for the game, over the chords Em, C, G and D
export const PONG_TUNE: Tune = {
  stepSeconds: 0.18,
  // prettier-ignore
  lead: [
    64, 67, 71, 76, 71, 67, null, 67,
    64, 67, 72, 76, 72, 67, null, 67,
    62, 67, 71, 74, 71, 67, null, 67,
    62, 66, 69, 74, 69, 66, null, 66,
  ],
  bass: [52, 48, 55, 50],
}

const midiToHz = (note: number) => 440 * 2 ** ((note - 69) / 12)

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
  {
    type = 'square',
    output = context.destination,
  }: { type?: OscillatorType; output?: AudioNode } = {},
) => {
  const start = context.currentTime + delay
  const oscillator = new OscillatorNode(context, {
    type,
    frequency,
  })
  const gain = new GainNode(context, { gain: VOLUME })
  // Fading out avoids the click of a wave cut off mid-cycle
  gain.gain.setValueAtTime(VOLUME, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
  oscillator.connect(gain).connect(output)
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

// The server can't see the saved choice, so it always renders the default
const useSoundOn = () => useSyncExternalStore(subscribe, isSoundOn, () => false)

// Loops while the calling page is mounted and sound is on
export const useLoopingMusic = (tune: Tune) => {
  const on = useSoundOn()

  useEffect(() => {
    if (!on) return
    let output: GainNode | undefined
    let step = 0
    let nextTime = 0

    const queueNotes = () => {
      // Waits for the first click to start the audio, and rests in a hidden tab
      if (audio?.state !== 'running' || document.hidden) return
      if (!output) {
        output = new GainNode(audio, { gain: MUSIC_VOLUME })
        output.connect(audio.destination)
      }
      // After a wait the tune carries on from here instead of rushing to catch up
      nextTime = Math.max(nextTime, audio.currentTime)

      while (nextTime < audio.currentTime + MUSIC_LOOKAHEAD_SECONDS) {
        const delay = nextTime - audio.currentTime
        const lead = tune.lead[step]
        if (lead !== null) {
          playTone(audio, midiToHz(lead), delay, tune.stepSeconds, { output })
        }
        if (step % MUSIC_BASS_EVERY_STEPS === 0) {
          const bar = Math.floor(step / MUSIC_STEPS_PER_BAR)
          playTone(
            audio,
            midiToHz(tune.bass[bar]),
            delay,
            tune.stepSeconds * MUSIC_BASS_EVERY_STEPS,
            { type: 'triangle', output },
          )
        }
        step = (step + 1) % tune.lead.length
        nextTime += tune.stepSeconds
      }
    }

    queueNotes()
    const timer = setInterval(queueNotes, MUSIC_TICK_MS)
    return () => {
      clearInterval(timer)
      // Cuts off the notes already queued
      output?.disconnect()
    }
  }, [on, tune])
}

export function SoundToggle({ className = '' }: { className?: string }) {
  const on = useSoundOn()

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
