// Shared connection utilities extracted from useReceiver and useSender
// to eliminate ~90 lines of duplicated heartbeat, RTT, and typing logic.

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

// ── Heartbeat ────────────────────────────────────────────────────────────
// Sends a ping every `interval` ms and checks for incoming activity every
// `interval` ms. If nothing has been received in `timeout` ms, calls
// `onDead`. Returns { markAlive, cleanup } — the caller must call
// markAlive() on every incoming message, and cleanup() on disconnect.
export function setupHeartbeat(conn: DataConnection, { onDead, interval = 5000, timeout = 30000 }: HeartbeatOptions): HeartbeatHandle {
  let lastSeen = Date.now()

  // Note: heartbeat pings are intentionally unencrypted (low-value timing data).
  // DTLS provides transport-layer encryption. Application-level E2E encryption
  // is reserved for content-bearing messages (chat, file chunks).
  const pingTimer = setInterval(() => {
    try { conn.send({ type: 'ping', ts: Date.now() }) } catch {}
  }, interval)

  const checkTimer = setInterval(() => {
    if (Date.now() - lastSeen > timeout) {
      cleanup()
      onDead()
    }
  }, interval)

  function markAlive(): void { lastSeen = Date.now() }

  function cleanup(): void {
    clearInterval(pingTimer)
    clearInterval(checkTimer)
  }

  return { markAlive, cleanup, getLastSeen: () => lastSeen }
}

export interface RTTPollingHandle {
  cleanup: () => void
}

// ── RTT polling ──────────────────────────────────────────────────────────
// Polls the RTCPeerConnection stats every `interval` ms and calls
// `setRtt(ms)` with the latest round-trip time. Returns { cleanup } or
// null if no peerConnection is available.
export function setupRTTPolling(
  peerConnection: RTCPeerConnection | null | undefined,
  setRtt: (rtt: number) => void,
  interval = 3000
): RTTPollingHandle | null {
  if (!peerConnection) return null

  const timer = setInterval(() => {
    peerConnection.getStats().then(stats => {
      stats.forEach(r => {
        const report = r as RTCIceCandidatePairStats
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
          setRtt(Math.round(report.currentRoundTripTime * 1000))
        }
      })
    }).catch(() => {})
  }, interval)

  return { cleanup: () => clearInterval(timer) }
}

// ── Typing indicator ─────────────────────────────────────────────────────
// Updates the typing-users list when a typing message arrives, then
// automatically removes the user after `duration` ms if no further typing
// events arrive. `timeoutMap` is a mutable object (e.g. a ref.current)
// keyed by nickname.
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
