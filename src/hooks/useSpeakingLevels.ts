import { useEffect, useRef, useState } from 'react'
import { getSharedAudioContext, ensureAudioContextRunning } from '../utils/audioContext'

// Tracks audio loudness (0–1) for an arbitrary set of MediaStreams using
// the shared AudioContext. Returns a stable map keyed by an opaque id
// chosen by the caller (peerId, 'self', etc.).
//
// One analyser per stream is unavoidable, but they all share a single
// AudioContext — the capped resource. Analyser nodes themselves are cheap.

export interface StreamEntry {
  id: string
  stream: MediaStream | null
  // If true, exclude from sampling (e.g., your own muted local stream).
  skip?: boolean
}

interface AnalyserSlot {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  buf: Uint8Array<ArrayBuffer>
}

const POLL_INTERVAL_MS = 120
const RMS_GAIN = 3

export function useSpeakingLevels(entries: StreamEntry[]): Record<string, number> {
  const [levels, setLevels] = useState<Record<string, number>>({})

  // Keep a ref of slots so we can rebuild incrementally as entries change
  // without recreating the entire graph each render.
  const slotsRef = useRef<Map<string, AnalyserSlot>>(new Map())
  const rafRef = useRef<number>(0)
  const lastSampleRef = useRef<number>(0)
  const lastEmittedRef = useRef<Record<string, number>>({})

  useEffect(() => {
    const ctx = getSharedAudioContext()
    if (!ctx) return

    const wantedIds = new Set<string>()
    entries.forEach(e => {
      if (e.skip || !e.stream) return
      const tracks = e.stream.getAudioTracks()
      if (!tracks.length) return
      wantedIds.add(e.id)

      const existing = slotsRef.current.get(e.id)
      // If the stream identity changed, rebuild the slot.
      if (existing && (existing.source.mediaStream !== e.stream)) {
        try { existing.source.disconnect() } catch {}
        try { existing.analyser.disconnect() } catch {}
        slotsRef.current.delete(e.id)
      }
      if (!slotsRef.current.has(e.id)) {
        try {
          const source = ctx.createMediaStreamSource(e.stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 512
          analyser.smoothingTimeConstant = 0.6
          source.connect(analyser)
          slotsRef.current.set(e.id, {
            source, analyser, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
          })
        } catch {
          // createMediaStreamSource throws on some browsers when the stream
          // has no live audio track (e.g., it was just stopped). Skip this
          // round; the next render will rebuild if the stream comes back.
        }
      }
    })

    // Drop slots whose entry is gone.
    slotsRef.current.forEach((slot, id) => {
      if (!wantedIds.has(id)) {
        try { slot.source.disconnect() } catch {}
        try { slot.analyser.disconnect() } catch {}
        slotsRef.current.delete(id)
      }
    })

    const tick = (): void => {
      // P4: skip the math entirely while the shared AudioContext is
      // suspended (tab backgrounded, browser autoplay policy, OS audio
      // ducking). Analysers return stale zeros in that state and we'd
      // just be spinning. The rAF continues at the browser's throttled
      // rate so we resume sampling as soon as the context wakes.
      if (ctx.state !== 'running') {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const now = performance.now()
      if (now - lastSampleRef.current >= POLL_INTERVAL_MS) {
        lastSampleRef.current = now
        const next: Record<string, number> = {}
        let dirty = false
        slotsRef.current.forEach((slot, id) => {
          slot.analyser.getByteTimeDomainData(slot.buf)
          let sum = 0
          for (let i = 0; i < slot.buf.length; i++) {
            const v = (slot.buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / slot.buf.length)
          const level = Math.min(1, rms * RMS_GAIN)
          next[id] = level
          const prev = lastEmittedRef.current[id]
          if (prev === undefined || Math.abs(prev - level) > 0.02) dirty = true
        })
        // Detect removals (slot deleted but still in last emitted)
        if (!dirty) {
          for (const id of Object.keys(lastEmittedRef.current)) {
            if (next[id] === undefined) { dirty = true; break }
          }
        }
        if (dirty) {
          lastEmittedRef.current = next
          setLevels(next)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    if (slotsRef.current.size > 0) {
      // Best-effort: if the context was suspended (returning from a hidden
      // tab, say), try to resume. Browsers block silent resumes without a
      // user gesture so this often no-ops — the tick guard above handles
      // that case by skipping samples until the context wakes naturally.
      ensureAudioContextRunning()
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      // Don't tear down slots here — only the entries effect rebuilds them.
      // This effect re-runs on every entries change; canceling rAF is enough.
    }
    // We deliberately depend on a stable signature derived from entries so
    // callers passing inline arrays don't thrash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureOf(entries)])

  // Final teardown on unmount.
  useEffect(() => {
    return () => {
      slotsRef.current.forEach(slot => {
        try { slot.source.disconnect() } catch {}
        try { slot.analyser.disconnect() } catch {}
      })
      slotsRef.current.clear()
    }
  }, [])

  return levels
}

function signatureOf(entries: StreamEntry[]): string {
  // Identity-based signature so adding/removing peers (or a stream swap)
  // re-runs the effect, but a parent re-render with the same data does not.
  let sig = ''
  for (const e of entries) {
    sig += e.id + ':' + (e.stream ? `s${(e.stream as MediaStream).id}` : 'null') + (e.skip ? 'x' : '') + '|'
  }
  return sig
}
