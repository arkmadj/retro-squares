import type { ComponentProps, CSSProperties } from 'react'

// ComponentProps includes ref, so callers can focus the button
type ButtonProps = ComponentProps<'button'> & {
  className?: string
  style?: CSSProperties
  // Primary is filled, for the main action in a menu
  variant?: 'primary' | 'secondary'
}

export const BUTTON_VARIANTS = {
  primary:
    'bg-green-500 text-black outline outline-green-500 hover:bg-green-400 active:bg-green-400',
  secondary:
    'text-green-500 outline outline-green-500 hover:bg-green-500 hover:text-black active:bg-green-500 active:text-black',
}

export function Button({
  className = '',
  style,
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`font-mono ${BUTTON_VARIANTS[variant]} ${className}`}
      style={style}
      {...props}
    />
  )
}
