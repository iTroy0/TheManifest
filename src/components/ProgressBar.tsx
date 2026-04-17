import { useAnimatedNumber } from '../hooks/useAnimatedNumber'

interface ProgressBarProps {
  percent: number
  label?: string
}

export default function ProgressBar({ percent, label }: ProgressBarProps) {
  const animatedPercent = useAnimatedNumber(percent)
  const isComplete = percent === 100

  return (
    <div className="space-y-1.5" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label || 'Transfer progress'}>
      {label && (
        <div className="flex justify-between items-center">
          <span className="font-mono text-[11px] text-muted truncate mr-2">{label}</span>
          <span className={`font-mono text-xs font-bold tabular-nums transition-colors ${isComplete ? 'text-accent' : 'text-info'}`} aria-live="polite">
            {animatedPercent}%
          </span>
        </div>
      )}
      <div className="h-2 bg-surface-2 rounded-full overflow-hidden border border-border/30">
        <div
          className={`h-full rounded-full relative transition-all duration-500 ease-out ${!isComplete ? 'shimmer-bar' : ''}`}
          style={{
            width: `${percent}%`,
            background: isComplete
              ? 'var(--color-accent)'
              : 'linear-gradient(90deg, var(--color-info), #6bb8ff)',
            boxShadow: percent > 0
              ? isComplete
                ? '0 0 12px var(--color-accent-glow)'
                : '0 0 8px rgba(74, 158, 255, 0.3)'
              : 'none',
          }}
        />
      </div>
    </div>
  )
}
