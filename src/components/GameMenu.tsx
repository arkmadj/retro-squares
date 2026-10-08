import type { ReactNode } from 'react'

type GameMenuProps = {
  title?: string
  message: ReactNode
  waiting?: boolean
  children?: ReactNode
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

export function GameMenu({
  title = 'Retro Squares',
  message,
  waiting = false,
  children,
}: GameMenuProps) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/80 p-4 text-center font-mono text-green-500"
    >
      <h2 className="text-2xl font-bold uppercase tracking-widest">{title}</h2>
      <p className="text-sm flex items-center gap-2 flex-col">
        {message}
        {waiting && <WaitingIcon />}
      </p>
      {children}
    </div>
  )
}
