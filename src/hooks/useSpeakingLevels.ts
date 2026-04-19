import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getSharedAudioContext, ensureAudioContextRunning } from '../utils/audioContext'

// Tracks audio loudness (0–1) for an arbitrary set of MediaStreams using
// the shared AudioContext. Returns a stable controller — `getLevel(id)` for
// imperative reads and `subscribe(id, cb)` for per-id listeners. No React
// state is updated on the consuming component, so a parent like CallPanel
// no longer rerenders 8×/sec just to push a number into one tile (which
// at 20 peers cascaded to ~160 tile rerenders/sec). Each tile subscribes
// to its own id via `useSpeakingLevel` and only rerenders on that id's
// change.
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

export interface SpeakingLevels {
  // Synchronous read for `useSyncExternalStore` snapshots and one-off reads.
  getLevel(id: string): number
  // Per-id subscription. The callback fires whenever this id's level
  // crosses the dirty threshold. Returns an unsubscribe.
  subscribe(id: string, onChange: () => void): () => void
}

const POLL_INTERVAL_MS = 120
const RMS_GAIN = 3
const DIRTY_THRESHOLD = 0.02

export function useSpeakingLevels(entries: StreamEntry[]): SpeakingLevels {
  const slotsRef = useRef<Map<string, AnalyserSlot>>(new Map())
  const rafRef = useRef<number>(0)
  const lastSampleRef = useRef<number>(0)
  // Last value emitted per id. Reads via getLevel; writes only when the
  // tick observes a > DIRTY_THRESHOLD change so subscribers only fire on
  // perceptible movement.
  const lastEmittedRef = useRef<Map<string, number>>(new Map())
  // Per-id subscriber set. Empty entries are removed on unsubscribe so
  // notify() doesn't pay an iteration cost for ids no one watches.
  const listenersRef = useRef<Map<string, Set<() => void>>>(new Map())

  // Stable controller object — identity must not change across renders or
  // every tile's `useSyncExternalStore` would tear down + resubscribe.
  const controller = useMemo<SpeakingLevels>(() => ({
    getLevel(id) { return lastEmittedRef.current.get(id) ?? 0 },
    subscribe(id, onChange) {
      let set = listenersRef.current.get(id)
      if (!set) {
        set = new Set()
        listenersRef.current.set(id, set)
      }
      set.add(onChange)
      return () => {
        set!.delete(onChange)
        if (set!.size === 0) listenersRef.current.delete(id)
      }
    },
  }), [])

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
        try { existing.source.disconnect() } catch { /* ignore */ }
        try { existing.analyser.disconnect() } catch { /* ignore */ }
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
        try { slot.source.disconnect() } catch { /* ignore */ }
        try { slot.analyser.disconnect() } catch { /* ignore */ }
        slotsRef.current.delete(id)
        // Notify any lingering subscribers so they read the cleared 0.
        if (lastEmittedRef.current.has(id)) {
          lastEmittedRef.current.delete(id)
          listenersRef.current.get(id)?.forEach(fn => { try { fn() } catch { /* ignore */ } })
        }
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
        slotsRef.current.forEach((slot, id) => {
          slot.analyser.getByteTimeDomainData(slot.buf)
          let sum = 0
          for (let i = 0; i < slot.buf.length; i++) {
            const v = (slot.buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / slot.buf.length)
          const level = Math.min(1, rms * RMS_GAIN)
          const prev = lastEmittedRef.current.get(id)
          if (prev === undefined || Math.abs(prev - level) > DIRTY_THRESHOLD) {
            lastEmittedRef.current.set(id, level)
            const subs = listenersRef.current.get(id)
            if (subs) {
              subs.forEach(fn => { try { fn() } catch { /* ignore */ } })
            }
          }
        })
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    if (slotsRef.current.size > 0) {
      // Best-effort: if the context was suspended (returning from a hidden
      // tab, say), try to resume. Browsers block silent resumes without a
      // user gesture so this often no-ops — the tick guard above skips
      // samples until the context wakes naturally.
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
        try { slot.source.disconnect() } catch { /* ignore */ }
        try { slot.analyser.disconnect() } catch { /* ignore */ }
      })
      slotsRef.current.clear()
      lastEmittedRef.current.clear()
      listenersRef.current.clear()
    }
  }, [])

  return controller
}

// Per-id subscription hook for tile components. Built on
// `useSyncExternalStore` so React batches the rerenders correctly and
// only the subscribing component re-runs on this id's change.
export function useSpeakingLevel(controller: SpeakingLevels, id: string): number {
  // `subscribe` and `getSnapshot` must keep stable identity across renders
  // for the same id; `useSyncExternalStore` retears down listeners when
  // the subscribe fn identity changes. Memo on (controller, id).
  const subscribe = useMemo(() => (cb: () => void) => controller.subscribe(id, cb), [controller, id])
  const getSnapshot = useMemo(() => (): number => controller.getLevel(id), [controller, id])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
