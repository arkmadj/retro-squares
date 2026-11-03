import { useSyncExternalStore } from 'react'
import { Button } from '#/components/common/Button'

const STORAGE_KEY = 'crt'

// Runs in the head before the first paint, so a saved choice never flashes the effect
export const CRT_INIT_SCRIPT = `try{if(localStorage.getItem('${STORAGE_KEY}')==='off')document.documentElement.dataset.crt='off'}catch{}`

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const isCrtOn = () => document.documentElement.dataset.crt !== 'off'

const setCrtOn = (on: boolean) => {
  if (on) delete document.documentElement.dataset.crt
  else document.documentElement.dataset.crt = 'off'
  // Storage can be blocked, and the switch still works until the page reloads
  try {
    if (on) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, 'off')
  } catch {}
  listeners.forEach((listener) => listener())
}

// The server can't see the saved choice, so it always renders the default
const useCrtOn = () => useSyncExternalStore(subscribe, isCrtOn, () => true)

export function CrtToggle() {
  const on = useCrtOn()

  return (
    <Button
      role="switch"
      aria-checked={on}
      aria-label="CRT effect"
      title="CRT effect"
      onClick={() => setCrtOn(!on)}
      className="crt-toggle fixed right-2 top-2 z-40 bg-black px-2 py-1 text-xs uppercase tracking-widest"
    >
      CRT {on ? 'on' : 'off'}
    </Button>
  )
}

export function CrtIconToggle({ className = '' }: { className?: string }) {
  const on = useCrtOn()

  return (
    <Button
      role="switch"
      aria-checked={on}
      aria-label="CRT effect"
      title="CRT effect"
      onClick={() => setCrtOn(!on)}
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
        <rect x="3" y="4" width="18" height="13" />
        <path d="M8 21h8" />
        {on ? <path d="M7 9h10M7 12.5h10" /> : <path d="M3 3l18 18" />}
      </svg>
    </Button>
  )
}
