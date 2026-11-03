import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '#/components/common/Button'

const THEMES = ['dark', 'light', 'green'] as const
type Theme = (typeof THEMES)[number]

const STORAGE_KEY = 'theme'

// Runs in the head before the first paint, so the page never flashes the wrong theme.
// Without a saved choice it follows the system setting. Dark is the page's default,
// so it sets no attribute.
export const THEME_INIT_SCRIPT = `{let t;try{t=localStorage.getItem('${STORAGE_KEY}')}catch{}if(t!=='dark'&&t!=='light'&&t!=='green')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(t!=='dark')document.documentElement.dataset.theme=t}`

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getTheme = (): Theme => {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || theme === 'green' ? theme : 'dark'
}

const setTheme = (theme: Theme) => {
  if (theme === 'dark') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  // Storage can be blocked, and the menu still works until the page reloads
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {}
  listeners.forEach((listener) => listener())
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      {theme === 'dark' && (
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      )}
      {theme === 'light' && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </>
      )}
      {theme === 'green' && (
        <>
          <rect x="4" y="4" width="16" height="16" />
          <rect x="9" y="9" width="6" height="6" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

export function ThemeToggle() {
  // The server can't see the saved choice, so it always renders the default
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'dark' as const)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus()

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') return close()
    if (event.key === 'Tab') return setOpen(false)

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    )
    const current = items.indexOf(document.activeElement as HTMLElement)
    const targets: Record<string, number> = {
      ArrowDown: (current + 1) % items.length,
      ArrowUp: (current - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }
    if (!(event.key in targets)) return
    event.preventDefault()
    items[targets[event.key]].focus()
  }

  return (
    <div ref={rootRef} className="fixed left-2 top-2 z-40">
      <Button
        ref={triggerRef}
        aria-label={`Theme: ${theme}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
        onClick={() => setOpen(!open)}
        className="theme-toggle block bg-black p-1.5"
      >
        <ThemeIcon theme={theme} />
      </Button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Theme"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full mt-2 flex w-32 flex-col bg-black font-mono text-xs uppercase tracking-widest text-green-500 outline outline-green-500"
        >
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === theme}
              onClick={() => {
                setTheme(option)
                close()
              }}
              className="flex items-center gap-2 px-2 py-1.5 uppercase outline-none hover:bg-green-500 hover:text-black focus:bg-green-500 focus:text-black"
            >
              <ThemeIcon theme={option} />
              {option}
              {option === theme && (
                <span aria-hidden="true" className="ml-auto">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
