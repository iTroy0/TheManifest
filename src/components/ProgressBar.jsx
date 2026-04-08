import { useAnimatedNumber } from '../hooks/useAnimatedNumber'

export default function ProgressBar({ percent, label }) {
  const animatedPercent = useAnimatedNumber(percent)

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex justify-between items-center">
          <span className="font-mono text-[10px] text-muted truncate mr-2">{label}</span>
          <span className="font-mono text-[10px] font-medium text-accent tabular-nums">{animatedPercent}%</span>
        </div>
      )}
      <div className="h-1.5 bg-border/60 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full relative shimmer-bar transition-all duration-500 ease-out"
          style={{
            width: `${percent}%`,
            background: percent === 100
              ? 'var(--color-accent)'
              : 'linear-gradient(90deg, var(--color-accent-dim), var(--color-accent))',
            boxShadow: percent > 0 ? '0 0 10px var(--color-accent-glow)' : 'none',
          }}
        />
      </div>
    </div>
  )
}
