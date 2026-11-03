import type { CSSProperties, ReactNode } from 'react'
import { Button } from '#/components/common/Button'
import { playArrow } from '#/components/SoundToggle'

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
        playArrow()
        onPress(true)
      }}
      onPointerUp={() => onPress(false)}
      onPointerCancel={() => onPress(false)}
      onLostPointerCapture={() => onPress(false)}
      onContextMenu={(event) => event.preventDefault()}
      className={`size-16 text-3xl max-md:size-12 max-md:text-2xl shrink-0 select-none touch-none ${className}`}
    >
      {children}
    </Button>
  )
}
