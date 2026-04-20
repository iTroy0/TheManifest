// Pure, React-free helpers for tuning WebRTC media connections.
// Extracted from useCall.ts to separate the encoder/codec knobs (which
// only touch RTCPeerConnection + RTCRtpSender) from the React lifecycle
// glue that lives in the hook. Each helper is safe to call on any PC
// at any time; guards short-circuit on browsers without the relevant
// capability (Safari, older Firefox).

// Prefer VP9 for every video transceiver on the given PC. VP9 compresses
// text and UI chrome ~30% better than VP8 at equivalent bitrate, which is
// the bulk of what users share. Falls back silently on browsers that don't
// expose getCapabilities (Safari) or don't offer VP9 encode.
//
// Call synchronously after peer.call / mc.answer — peerjs creates the PC,
// adds tracks, then queues createOffer/Answer on the microtask queue, so
// mutating transceiver codec preferences now lands before the SDP is
// generated.
export function preferVp9OnPc(pc: RTCPeerConnection | null | undefined): void {
  if (!pc) return
  if (typeof RTCRtpReceiver === 'undefined') return
  if (typeof RTCRtpReceiver.getCapabilities !== 'function') return
  const recvCaps = RTCRtpReceiver.getCapabilities('video')
  if (!recvCaps || !recvCaps.codecs) return
  // H9 — gate on BOTH encode and decode capability. On iOS Safari < 16.4
  // the receiver may advertise VP9 decode only if the builtin decoder
  // variant matches; preferring VP9 when we cannot also encode it leaves
  // the remote peer with a codec we negotiated but can't drive.
  let senderHasVp9 = true
  if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
    const sendCaps = RTCRtpSender.getCapabilities('video')
    senderHasVp9 = !!sendCaps?.codecs?.some(c => c.mimeType.toLowerCase() === 'video/vp9')
  }
  if (!senderHasVp9) return
  const preferred: RTCRtpCodec[] = []
  const fallback: RTCRtpCodec[] = []
  for (const c of recvCaps.codecs) {
    const mime = c.mimeType.toLowerCase()
    if (mime === 'video/vp9') preferred.push(c)
    else fallback.push(c)
  }
  if (preferred.length === 0) return
  const ordered = [...preferred, ...fallback]
  pc.getTransceivers().forEach(tx => {
    const kind = tx.sender?.track?.kind ?? tx.receiver?.track?.kind
    if (kind !== 'video') return
    try { tx.setCodecPreferences(ordered) } catch {}
  })
}

type ParamsWithDegradation = RTCRtpSendParameters & { degradationPreference?: string }

// Tune screen-share senders on the given PC for spatial quality over
// temporal smoothness. contentHint='detail' biases the encoder toward
// crisp text/UI edges — the right tradeoff for code editors, docs, and
// slides, which are the bulk of what users share.
export function tuneScreenSendersOnPc(pc: RTCPeerConnection): void {
  pc.getSenders().forEach(sender => {
    if (sender.track?.kind !== 'video') return
    try { sender.track.contentHint = 'detail' } catch {}
    try {
      const params = sender.getParameters()
      const enc = params.encodings?.[0] ?? {}
      enc.maxBitrate = 4_000_000
      enc.maxFramerate = 30
      params.encodings = [enc]
      // Prefer lower resolution over dropped frames when bandwidth
      // tightens — smoother perceived motion for screen content.
      ;(params as ParamsWithDegradation).degradationPreference = 'maintain-framerate'
      sender.setParameters(params).catch(() => {})
    } catch {}
  })
}

// Force the encoder to emit a keyframe on the given PC's video senders.
// Toggling track.enabled false -> true is the most reliable cross-browser
// nudge; Chromium emits a fresh keyframe on re-enable so a freshly-
// negotiated receiver doesn't stare at black while waiting for the next
// regular keyframe. Called after every new mc.on('stream') during an
// active share.
export function forceKeyframeOnPc(pc: RTCPeerConnection): void {
  pc.getSenders().forEach(sender => {
    const track = sender.track
    if (!track || track.kind !== 'video' || track.readyState === 'ended') return
    try {
      track.enabled = false
      setTimeout(() => {
        try { if (track.readyState !== 'ended') track.enabled = true } catch {}
      }, 60)
    } catch {}
  })
}

export interface VideoEncoding {
  maxBitrate: number
  maxFramerate: number
  scaleResolutionDownBy: number
}

// M-v — camera senders cap. A 20-peer mesh means each local camera is
// encoded 19 times (one stream per PC, no SFU). With the default encoder
// budget ~2.5 Mbps per stream, a modest home uplink saturates around 4-5
// active video peers. Adaptive: pure mesh has no simulcast or SFU, so a
// sender at N peers encodes the same stream N times for N upload streams.
// We pick a per-encoding bitrate that keeps total upload within realistic
// home/cellular uplinks while maximizing 1:1 quality where the user has
// the bandwidth headroom to spend.
//
//   ≤1 remote = 1:1 → 4.0 Mbps (VP9 1080p30 ceiling for talking-head /
//                                light motion; beyond is diminishing returns)
//   2-3 remote = small group → 1.8 Mbps × N senders, N≤4 = ≤7.2 Mbps up
//   4-8 remote = mid group → 1.2 Mbps × N, N≤9 = ≤10.8 Mbps up
//   9+ remote = large mesh → 800 kbps + 1.5x downscale (1080p→720p) so
//                            the encoder spends fewer cycles per peer
//
// 30 fps target across the board (smoother than 24 on talking-head).
// degradationPreference='maintain-framerate' tells the encoder to drop
// resolution before fps when bitrate gets squeezed mid-call.
export function pickVideoEncoding(remoteCount: number): VideoEncoding {
  if (remoteCount <= 1) return { maxBitrate: 4_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }
  if (remoteCount <= 3) return { maxBitrate: 1_800_000, maxFramerate: 30, scaleResolutionDownBy: 1 }
  if (remoteCount <= 8) return { maxBitrate: 1_200_000, maxFramerate: 30, scaleResolutionDownBy: 1 }
  return { maxBitrate: 800_000, maxFramerate: 30, scaleResolutionDownBy: 1.5 }
}

// Tune camera senders on the given PC for the mesh size. Caller passes
// remote count (peers excluding self) so this stays pure — no React refs.
export function tuneCameraSendersOnPc(pc: RTCPeerConnection, remoteCount: number): void {
  const target = pickVideoEncoding(remoteCount)
  pc.getSenders().forEach(sender => {
    if (sender.track?.kind !== 'video') return
    try {
      const params = sender.getParameters()
      const enc = params.encodings?.[0] ?? {}
      enc.maxBitrate = target.maxBitrate
      enc.maxFramerate = target.maxFramerate
      enc.scaleResolutionDownBy = target.scaleResolutionDownBy
      params.encodings = [enc]
      ;(params as ParamsWithDegradation).degradationPreference = 'maintain-framerate'
      sender.setParameters(params).catch(() => {})
    } catch { /* noop */ }
  })
}
