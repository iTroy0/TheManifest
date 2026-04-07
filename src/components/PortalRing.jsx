export default function PortalRing({ status }) {
  const isWaiting = status === 'waiting'
  const isConnected = status === 'connected' || status === 'transferring' || status === 'done'

  if (!isWaiting && !isConnected) return null

  return (
    <div className="flex justify-center py-4">
      <div className="relative w-24 h-24">
        {/* Outer ring */}
        <div className={`
          absolute inset-0 rounded-full border-2
          transition-all duration-1000
          ${isConnected ? 'border-accent/60' : 'border-accent/20 animate-[portal-spin_8s_linear_infinite]'}
        `} />

        {/* Middle ring */}
        <div className={`
          absolute inset-2 rounded-full border
          transition-all duration-1000
          ${isConnected ? 'border-accent/40' : 'border-accent/10 animate-[portal-spin_6s_linear_infinite_reverse]'}
        `} />

        {/* Inner glow */}
        <div className={`
          absolute inset-4 rounded-full
          transition-all duration-1000
          ${isConnected
            ? 'bg-accent/10 shadow-[0_0_30px_rgba(0,255,136,0.3)]'
            : 'bg-accent/5 animate-breathe shadow-[0_0_20px_rgba(0,255,136,0.1)]'
          }
        `} />

        {/* Ripple rings when waiting */}
        {isWaiting && (
          <>
            <div className="absolute inset-0 rounded-full border border-accent/20 animate-[ripple_3s_ease-out_infinite]" />
            <div className="absolute inset-0 rounded-full border border-accent/20 animate-[ripple_3s_ease-out_1s_infinite]" />
            <div className="absolute inset-0 rounded-full border border-accent/20 animate-[ripple_3s_ease-out_2s_infinite]" />
          </>
        )}

        {/* Center dot */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={`
            w-3 h-3 rounded-full
            ${isConnected ? 'bg-accent shadow-[0_0_10px_rgba(0,255,136,0.6)]' : 'bg-accent/60 animate-pulse'}
          `} />
        </div>
      </div>
    </div>
  )
}
