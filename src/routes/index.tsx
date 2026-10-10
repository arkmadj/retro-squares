import { Link, createFileRoute } from '@tanstack/react-router'
import { WIN_SCORE } from '#/server/updates'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="min-h-svh flex flex-col items-center justify-center gap-10 p-4 text-center font-mono text-green-500">
      <header className="flex flex-col items-center gap-3">
        <div aria-hidden="true" className="grid grid-cols-4 gap-1">
          {Array.from({ length: 8 }, (_, i) => (
            <span
              key={i}
              className={`size-3 ${i % 3 === 0 ? 'bg-green-500' : 'border border-green-500/40'}`}
            />
          ))}
        </div>
        <h1 className="text-4xl font-bold uppercase tracking-widest">
          Retro Squares
        </h1>
        <p className="text-sm text-green-500/70">
          Real-time retro games for two players
        </p>
      </header>

      <section
        aria-labelledby="pong-title"
        className="game-width flex flex-col items-center gap-4 p-6 outline outline-green-500"
      >
        <h2
          id="pong-title"
          className="text-2xl font-bold uppercase tracking-widest"
        >
          Pong
        </h2>
        <p className="text-sm">
          Share a link with a friend. First to {WIN_SCORE} points wins.
        </p>
        <Link
          to="/pong"
          className="px-6 py-2 outline outline-green-500 hover:bg-green-500 hover:text-black active:bg-green-500 active:text-black"
        >
          Play
        </Link>
        <p className="text-xs text-green-500/70">
          Move with ← / → or A / D. On touch, hold the on-screen arrows.
        </p>
      </section>
    </main>
  )
}
