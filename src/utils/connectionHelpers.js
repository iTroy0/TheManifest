// Shared connection utilities extracted from useReceiver and useSender
// to eliminate ~90 lines of duplicated heartbeat, RTT, and typing logic.

// ── Heartbeat ────────────────────────────────────────────────────────────
// Sends a ping every `interval` ms and checks for incoming activity every
// `interval` ms. If nothing has been received in `timeout` ms, calls
// `onDead`. Returns { markAlive, cleanup } — the caller must call
// markAlive() on every incoming message, and cleanup() on disconnect.
export function setupHeartbeat(conn, { onDead, interval = 5000, timeout = 30000 }) {
  let lastSeen = Date.now()

  const pingTimer = setInterval(() => {
    try { conn.send({ type: 'ping', ts: Date.now() }) } catch {}
  }, interval)

  const checkTimer = setInterval(() => {
    if (Date.now() - lastSeen > timeout) {
      cleanup()
      onDead()
    }
  }, interval)

  function markAlive() { lastSeen = Date.now() }

  function cleanup() {
    clearInterval(pingTimer)
    clearInterval(checkTimer)
  }

  return { markAlive, cleanup, getLastSeen: () => lastSeen }
}

// ── RTT polling ──────────────────────────────────────────────────────────
// Polls the RTCPeerConnection stats every `interval` ms and calls
// `setRtt(ms)` with the latest round-trip time. Returns { cleanup } or
// null if no peerConnection is available.
export function setupRTTPolling(peerConnection, setRtt, interval = 3000) {
  if (!peerConnection) return null

  const timer = setInterval(() => {
    peerConnection.getStats().then(stats => {
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          setRtt(Math.round(r.currentRoundTripTime * 1000))
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
export function handleTypingMessage(nick, setTypingUsers, timeoutMap, duration = 3000) {
  setTypingUsers(prev => prev.includes(nick) ? prev : [...prev, nick])
  clearTimeout(timeoutMap[nick])
  timeoutMap[nick] = setTimeout(() => {
    setTypingUsers(prev => prev.filter(n => n !== nick))
  }, duration)
}
