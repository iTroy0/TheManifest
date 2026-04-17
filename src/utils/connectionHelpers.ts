import type { DataConnection } from 'peerjs'
import type React from 'react'

export interface HeartbeatOptions {
  onDead: () => void
  interval?: number
  timeout?: number
}

export interface HeartbeatHandle {
  markAlive: () => void
  cleanup: () => void
  getLastSeen: () => number
}

export function setupHeartbeat(conn: DataConnection, { onDead, interval = 5000, timeout = 15000 }: HeartbeatOptions): HeartbeatHandle {
  let lastSeen = Date.now()

  // Heartbeat pings are intentionally unencrypted (low-value timing data);
  // E2E encryption is reserved for content-bearing messages.
  // Counter only resets on markAlive — alternating send-success/no-response
  // would otherwise mask a half-open connection indefinitely.
  let consecutivePingFailures = 0

  const pingTimer = setInterval(() => {
    try {
      conn.send({ type: 'ping', ts: Date.now() })
      consecutivePingFailures = 0
    } catch {
      consecutivePingFailures++
      if (consecutivePingFailures >= 3) {
        cleanup()
        onDead()
        return
      }
    }
  }, interval)

  // Reset lastSeen and ping failure counter on wake to prevent false-positive
  // death after sleep (setInterval paused during sleep, then fires immediately)
  const handleVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      lastSeen = Date.now()
      consecutivePingFailures = 0
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }

  const checkTimer = setInterval(() => {
    if (Date.now() - lastSeen > timeout) {
      cleanup()
      onDead()
    }
  }, interval)

  function markAlive(): void {
    lastSeen = Date.now()
    consecutivePingFailures = 0
  }

  function cleanup(): void {
    clearInterval(pingTimer)
    clearInterval(checkTimer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }

  return { markAlive, cleanup, getLastSeen: () => lastSeen }
}

export interface RTTPollingHandle {
  cleanup: () => void
}

export function setupRTTPolling(
  peerConnection: RTCPeerConnection | null | undefined,
  setRtt: (rtt: number | null) => void,
  interval = 3000
): RTTPollingHandle | null {
  if (!peerConnection) return null

  let missedPolls = 0

  const timer = setInterval(() => {
    peerConnection.getStats().then(stats => {
      let best: number | null = null
      let fallback: number | null = null
      stats.forEach(r => {
        const report = r as RTCIceCandidatePairStats
        if (report.type !== 'candidate-pair') return
        if (report.currentRoundTripTime == null) return
        const ms = Math.round(report.currentRoundTripTime * 1000)
        if (report.state === 'succeeded') {
          if (best == null || ms < best) best = ms
        } else if (report.state === 'in-progress') {
          if (fallback == null || ms < fallback) fallback = ms
        }
      })
      const picked = best ?? fallback
      if (picked != null) {
        missedPolls = 0
        setRtt(picked)
      } else {
        missedPolls++
          if (missedPolls >= 3) setRtt(null)
      }
    }).catch((err) => { console.warn('RTT stats query failed:', err) })
  }, interval)

  return { cleanup: () => clearInterval(timer) }
}

export function handleTypingMessage(
  nick: string,
  setTypingUsers: React.Dispatch<React.SetStateAction<string[]>>,
  timeoutMap: Record<string, ReturnType<typeof setTimeout>>,
  duration = 3000
): void {
  setTypingUsers(prev => prev.includes(nick) ? prev : [...prev, nick])
  clearTimeout(timeoutMap[nick])
  timeoutMap[nick] = setTimeout(() => {
    setTypingUsers(prev => prev.filter(n => n !== nick))
  }, duration)
}
