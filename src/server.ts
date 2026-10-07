import handler from '@tanstack/react-start/server-entry'

export { GameRoom } from './server/GameRoom'

const ROOM_PATH = /^\/ws\/([\w-]{1,64})$/

export default {
  async fetch(request: Request, env: Env) {
    const match = new URL(request.url).pathname.match(ROOM_PATH)
    if (match) {
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(match[1]))
      return room.fetch(request)
    }
    return handler.fetch(request)
  },
}
