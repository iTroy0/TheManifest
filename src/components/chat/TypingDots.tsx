const TYPING_DELAY_0 = { animationDelay: '0ms' }
const TYPING_DELAY_1 = { animationDelay: '150ms' }
const TYPING_DELAY_2 = { animationDelay: '300ms' }

export default function TypingDots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_0} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_1} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_2} />
    </span>
  )
}
