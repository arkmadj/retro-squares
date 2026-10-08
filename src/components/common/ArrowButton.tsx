import type { CSSProperties, ReactNode } from 'react'
import { Button } from '#/components/common/Button'

type ArrowButtonProps = {
  label: string
  onPress: (active: boolean) => void
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function ArrowButton({
  label,
  onPress,
  children,
  className = '',
  style,
}: ArrowButtonProps) {
  return (
    <Button
      aria-label={label}
      style={style}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        onPress(true)
      }}
      onPointerUp={() => onPress(false)}
      onPointerCancel={() => onPress(false)}
      onLostPointerCapture={() => onPress(false)}
      onContextMenu={(event) => event.preventDefault()}
      className={`size-16 text-3xl select-none touch-none ${className}`}
    >
      {children}
    </Button>
  )
}
