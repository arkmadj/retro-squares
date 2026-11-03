import { Children, useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { CrtIconToggle } from '#/components/CrtToggle'
import { SoundToggle, playClick } from '#/components/SoundToggle'
import { ThemeToggle } from '#/components/ThemeToggle'

type GameMenuContent = {
  title?: string
  message: ReactNode
  waiting?: boolean
  children?: ReactNode
}

type GameMenuProps = GameMenuContent & {
  // The menu stays mounted until its exit animation ends
  open?: boolean
}

const WAITING_DELAYS = ['0ms', '150ms', '300ms']

function WaitingIcon() {
  return (
    <span aria-hidden="true" className="inline-flex items-end gap-1 h-3">
      {WAITING_DELAYS.map((delay) => (
        <span
          key={delay}
          className="size-1.5 bg-green-500 animate-bounce"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  )
}

const itemStyle = (index: number) =>
  ({ '--menu-index': index }) as CSSProperties

// Set on the menu's content, because its toggles already play their own click
const playContentClick = (event: MouseEvent) => {
  if ((event.target as Element).closest('a, button')) playClick()
}

export function GameMenu({ open = true, ...content }: GameMenuProps) {
  const [mounted, setMounted] = useState(open)
  // Last content shown while open, kept on screen during the exit animation
  const lastContent = useRef(content)
  useEffect(() => {
    if (open) lastContent.current = content
  })
  if (open && !mounted) setMounted(true)
  if (!mounted) return null

  const {
    title = 'Pong',
    message,
    waiting = false,
    children,
  } = open ? content : lastContent.current
  const hasChildren = Children.toArray(children).length > 0

  return (
    <div
      role="dialog"
      aria-label={title}
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      onAnimationEnd={(event) => {
        if (!open && event.target === event.currentTarget) setMounted(false)
      }}
      style={{ '--menu-items': hasChildren ? 3 : 2 } as CSSProperties}
      className="game-menu absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4 text-center font-mono text-green-500"
    >
      <div className="game-menu-panel relative flex w-full flex-col items-center gap-4 bg-black/90 px-4 py-6 outline outline-green-500">
        <h2
          style={itemStyle(0)}
          className="game-menu-item game-menu-glow text-2xl font-bold uppercase tracking-widest"
        >
          {title}
        </h2>
        <div
          style={itemStyle(1)}
          onClick={playContentClick}
          className="game-menu-item flex flex-col items-center gap-2 text-sm"
        >
          {message}
          {waiting && <WaitingIcon />}
        </div>
        {hasChildren && (
          <div
            style={itemStyle(2)}
            onClick={playContentClick}
            className="game-menu-item flex w-full flex-col items-stretch gap-2"
          >
            {children}
          </div>
        )}
        {/* Phones hide the page's toggles on the game screen */}
        <CrtIconToggle className="absolute right-1 top-1 hidden max-md:pointer-coarse:block" />
        {/* Below the CRT toggle, because a short phone's panel is too narrow beside the title */}
        <SoundToggle className="absolute right-1 top-10 hidden max-md:pointer-coarse:block" />
        <ThemeToggle className="absolute left-1 top-1 hidden max-md:pointer-coarse:block" />
      </div>
    </div>
  )
}
