import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, Player, ServerMessage } from '#/server/GameRoom'
import type { BallPosition } from '#/hooks/useBallMovement'

export type RoomStatus = 'connecting' | 'waiting' | 'playing' | 'closed'

type UseGameRoomOptions = {
  roomId: string | undefined
  onOpponentMove: (offset: number) => void
  onBallMove: (position: BallPosition) => void
}

export const useGameRoom = ({
  roomId,
  onOpponentMove,
  onBallMove,
}: UseGameRoomOptions) => {
  const socket = useRef<WebSocket | null>(null)
  const onOpponentMoveRef = useRef(onOpponentMove)
  const onBallMoveRef = useRef(onBallMove)
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [player, setPlayer] = useState<Player | null>(null)

  useEffect(() => {
    onOpponentMoveRef.current = onOpponentMove
  }, [onOpponentMove])

  useEffect(() => {
    onBallMoveRef.current = onBallMove
  }, [onBallMove])

  useEffect(() => {
    if (!roomId) return

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${location.host}/ws/${roomId}`)
    socket.current = ws
    setStatus('connecting')

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data) as ServerMessage
      switch (message.type) {
        case 'welcome':
          setPlayer(message.player)
          setStatus('waiting')
          break
        case 'opponent':
          setStatus(message.connected ? 'playing' : 'waiting')
          if (!message.connected) {
            onOpponentMoveRef.current(0)
            onBallMoveRef.current({ x: 0, y: 0 })
          }
          break
        case 'move':
          onOpponentMoveRef.current(message.offset)
          break
        case 'ball':
          onBallMoveRef.current({ x: message.x, y: message.y })
          break
      }
    })
    ws.addEventListener('close', () => setStatus('closed'))

    return () => {
      socket.current = null
      ws.close()
    }
  }, [roomId])

  const sendMove = useCallback((offset: number) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'move', offset } satisfies ClientMessage))
  }, [])

  const sendBall = useCallback(({ x, y }: BallPosition) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ball', x, y } satisfies ClientMessage))
  }, [])

  return { status, player, sendMove, sendBall }
}
