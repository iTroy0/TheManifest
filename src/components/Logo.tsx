import { useId } from 'react'

interface LogoProps {
  className?: string
  strokeWidth?: number
}

// Brand mark: stylized "M" monogram in cyan→violet gradient with a glowing
// cyan node at the center valley (the "meeting point" of two peers). Designed
// for placement inside the existing `glass-accent` rounded-square wrapper used
// across page headers — that wrapper provides the dark surface + glow halo.
export default function Logo({ className = 'w-4 h-4', strokeWidth = 2.8 }: LogoProps) {
  const gradId = useId()
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#67e8f9"/>
          <stop offset="55%" stopColor="#22d3ee"/>
          <stop offset="100%" stopColor="#8b5cf6"/>
        </linearGradient>
      </defs>
      <path
        d="M 7 24 L 7 9 L 16 18 L 25 9 L 25 24"
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="18.5" r="2.6" fill="#22d3ee" fillOpacity="0.28"/>
      <circle cx="16" cy="18.5" r="1.3" fill="#a5f3fc"/>
    </svg>
  )
}
