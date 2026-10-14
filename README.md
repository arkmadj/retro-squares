# Retro Squares

Retro Squares is a collection of real-time, two-player retro games with a green-on-black CRT look. It's built with TanStack Start and runs on Cloudflare Workers.

**Live demo:** https://retro-squares.ahmadjinadu.com

## Games

- **Pong** — playable now. A bat-and-ball game where the first player to 5 points wins.
- **Coming soon:** Light Cycles, Snake Duel and Breakout Battle.

## How To Play Pong

1. Open the home page and press **Play**, or go to `/pong`. A new room is created and its ID is added to the URL.
2. Share the link with a second player.
3. Move your bat with `←` / `→` or `A` / `D`. On touch devices, hold the on-screen `←` / `→` buttons.
4. When a player misses the ball, the other player scores a point. The first to 5 points wins, and both players press **Rematch** to start a new game.

## How It Works

- **Game rooms.** Each room is a Cloudflare Durable Object (`GameRoom`). Players join over a WebSocket at `/ws/{room}`.
- **Fair placement.** When both players have joined, the lobby picks the Cloudflare region whose distance to the further player is smallest. Both players then move to a room in that region at `/ws/{room}/{region}`, so neither has a latency advantage.
- **Peer-to-peer updates.** Players use the room to exchange WebRTC signalling, then send bat and ball updates to each other over data channels. Bat updates are unordered and are not retransmitted; ball updates are unordered but reliable. When a direct connection isn't available, updates go through the room's WebSocket instead.
- **Clock sync.** Clients ping the room to estimate the server clock and round-trip time. The room uses these estimates to schedule each serve so both players see it start at the same moment.
- **NAT traversal.** The worker serves ICE servers to the browser. It uses STUN by default and adds Cloudflare TURN when TURN credentials are set.

## Project Structure

```
src/
  routes/          Home page (index.tsx) and the Pong game (pong.tsx)
  components/      Game menu and shared buttons
  hooks/           Room connection, WebRTC peer link, clock sync, bat and ball movement
  server/          GameRoom Durable Object, message types and update parsing
  server.ts        Worker entry: ICE servers, WebSocket routing, app handler
wrangler.jsonc     Worker and Durable Object configuration
```

## Getting Started

```bash
npm install
npm run dev
```

The app runs at http://localhost:3000.

### TURN (optional)

Players behind strict NATs may need TURN to connect directly. Create a TURN key in the Cloudflare dashboard (**Realtime > TURN**) and add it to `.dev.vars` for local development:

```
TURN_KEY_ID=...
TURN_KEY_API_TOKEN=...
```

Without these, only STUN is used, and players who can't connect directly play through the room's WebSocket.

## Scripts

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Start the dev server on port 3000             |
| `npm run build`      | Build for production                          |
| `npm run preview`    | Preview the production build                  |
| `npm run deploy`     | Build and deploy to Cloudflare Workers        |
| `npm run lint`       | Run ESLint                                    |
| `npm run format`     | Format with Prettier and fix lint issues      |
| `npm run check`      | Check formatting                              |
| `npm run cf-typegen` | Regenerate Worker types from `wrangler.jsonc` |

## Deploying

1. Log in to Cloudflare with `npx wrangler login`.
2. Optionally, set the TURN secrets:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
3. Run `npm run deploy`.

## Tech Stack

- [TanStack Start](https://tanstack.com/start) and [TanStack Router](https://tanstack.com/router) with file-based routing
- React 19
- [Tailwind CSS](https://tailwindcss.com/) v4
- Cloudflare Workers and Durable Objects, through the Cloudflare Vite plugin
- WebRTC data channels for peer-to-peer game updates
