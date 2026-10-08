import type { ButtonHTMLAttributes, CSSProperties } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  className?: string
  style?: CSSProperties
}

export function Button({
  className = '',
  style,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`text-green-500 font-mono outline outline-green-500 hover:bg-green-500 hover:text-black active:bg-green-500 active:text-black ${className}`}
      style={style}
      {...props}
    />
  )
}
