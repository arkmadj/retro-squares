import handler from '@tanstack/react-start/server-entry'

import { LOCATION_HEADER, isRoomHint } from './server/GameRoom'
import {
  ICE_CREDENTIAL_TTL,
  ICE_SERVERS_PATH,
  STUN_SERVERS,
} from './server/updates'
import type { IceServer } from './server/updates'

export { GameRoom } from './server/GameRoom'

// /ws/{room} is the lobby; /ws/{room}/{hint} is the game placed between both players
const ROOM_PATH = /^\/ws\/([\w-]{1,64})(?:\/([\w-]{1,16}))?$/
// Browsers block port 53, so these URLs would only time out
const BLOCKED_PORT = /:53(?:\?|$)/

// Cloudflare TURN key, set with `wrangler secret put`; without it only STUN is used
type TurnEnv = Env & { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string }

const createIceServers = async (env: TurnEnv): Promise<IceServer[]> => {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_SERVERS
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: ICE_CREDENTIAL_TTL }),
      },
    )
    if (!response.ok) return STUN_SERVERS
    const { iceServers } = await response.json<{ iceServers: IceServer[] }>()
    return iceServers.map((server) => ({
      ...server,
      urls: [server.urls].flat().filter((url) => !BLOCKED_PORT.test(url)),
    }))
  } catch {
    return STUN_SERVERS
  }
}

export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: TurnEnv,
  ) {
    const { pathname } = new URL(request.url)
    if (pathname === ICE_SERVERS_PATH) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 })
      }
      return Response.json(
        { iceServers: await createIceServers(env) },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const match = pathname.match(ROOM_PATH)
    if (match) {
      const [, name, hint] = match
      const headers = new Headers(request.headers)
      headers.delete(LOCATION_HEADER)

      let room
      if (!hint) {
        const { latitude, longitude } = request.cf ?? {}
        if (latitude && longitude) {
          headers.set(LOCATION_HEADER, `${latitude},${longitude}`)
        }
        room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(name))
      } else if (isRoomHint(hint)) {
        room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(`${name}/${hint}`), {
          locationHint: hint,
        })
      } else {
        return new Response('Unknown location', { status: 404 })
      }
      return room.fetch(new Request(request, { headers }))
    }
    return handler.fetch(request)
  },
}
