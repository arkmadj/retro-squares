import { Link, createFileRoute } from '@tanstack/react-router'
import type { CSSProperties } from 'react'
import { WIN_SCORE } from '#/server/updates'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="home-crt min-h-svh flex flex-col items-center justify-center gap-10 p-4 text-center font-mono text-green-500">
      <header
        className="home-enter flex flex-col items-center gap-3"
        style={{ '--enter-index': 0 } as CSSProperties}
      >
        <div aria-hidden="true" className="grid grid-cols-4 gap-1">
          {Array.from({ length: 8 }, (_, i) => (
            <span
              key={i}
              className={`home-logo-cell size-3 ${i % 3 === 0 ? 'bg-green-500' : 'border border-green-500/40'}`}
              style={{ '--cell-index': i } as CSSProperties}
            />
          ))}
        </div>
        <h1 className="home-glow home-flicker text-4xl font-bold uppercase tracking-widest">
          Retro Squares
        </h1>
        <p className="text-sm text-green-500/70">
          Real-time retro games for two players
        </p>
      </header>

      <section
        aria-labelledby="pong-title"
        className="home-enter home-card game-width flex flex-col items-center gap-4 p-6 outline outline-green-500"
        style={{ '--enter-index': 1 } as CSSProperties}
      >
        <h2
          id="pong-title"
          className="home-glow text-2xl font-bold uppercase tracking-widest"
        >
          Pong
        </h2>
        <div
          aria-hidden="true"
          className="home-pong relative h-24 w-full outline outline-green-500/40"
        >
          <span className="home-pong-bat top-0" />
          <span className="home-pong-ball" />
          <span className="home-pong-bat bottom-0" />
        </div>
        <p className="text-sm">
          Share a link with a friend. First to {WIN_SCORE} points wins.
        </p>
        <Link
          to="/pong"
          className="px-6 py-2 uppercase tracking-widest outline outline-green-500 hover:bg-green-500 hover:text-black active:bg-green-500 active:text-black"
        >
          <span aria-hidden="true" className="home-blink mr-2">
            ▶
          </span>
          Play
        </Link>
        <p className="text-xs text-green-500/70">
          Move with ← / → or A / D. On touch, hold the on-screen arrows.
        </p>
      </section>
    </main>
  )
}
