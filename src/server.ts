import handler from '@tanstack/react-start/server-entry'

import { LOCATION_HEADER, isRoomHint } from './server/GameRoom'

export { GameRoom } from './server/GameRoom'

// /ws/{room} is the lobby; /ws/{room}/{hint} is the game placed between both players
const ROOM_PATH = /^\/ws\/([\w-]{1,64})(?:\/([\w-]{1,16}))?$/

export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: Env,
  ) {
    const match = new URL(request.url).pathname.match(ROOM_PATH)
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
