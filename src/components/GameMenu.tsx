import { Children, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

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
    title = 'Retro Squares',
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
      className="game-menu absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/80 p-4 text-center font-mono text-green-500"
    >
      <h2
        style={itemStyle(0)}
        className="game-menu-item text-2xl font-bold uppercase tracking-widest"
      >
        {title}
      </h2>
      <p
        style={itemStyle(1)}
        className="game-menu-item text-sm flex items-center gap-2 flex-col"
      >
        {message}
        {waiting && <WaitingIcon />}
      </p>
      {hasChildren && (
        <div style={itemStyle(2)} className="game-menu-item">
          {children}
        </div>
      )}
    </div>
  )
}
