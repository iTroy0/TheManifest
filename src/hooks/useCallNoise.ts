// Neural noise suppression (RNNoise) toggle for the call lane.
// Owns the lazy WASM pipeline build, AudioContext lifecycle, and
// toggle UI state. Extracted from useCall so the media/track plumbing
// there isn't interleaved with the feature flag.
//
// The raw mic stays in localStream (speaking-level analysers, screen-
// share mixer still read it). When enabled, the denoised track is
// pushed onto every RTCRtpSender via the injected swapAudioTrack so
// remote peers hear the cleaned audio. Composition with the screen-
// share mixer is intentionally not handled: while sharing a screen
// with audio, the mixer reads raw mic, so denoise is bypassed for the
// mix duration. The toggle's UI state persists through the share so it
// re-applies cleanly on stop.

import { useCallback, useRef, useState } from 'react'
import type { RnnoisePipeline } from '../utils/rnnoise'
import { getSharedAudioContext, ensureAudioContextRunning } from '../utils/audioContext'

export interface UseCallNoiseOptions {
  // Live ref to the local MediaStream so we always read the current
  // mic track (not a stale captured stream from mount time).
  localStreamRef: React.MutableRefObject<MediaStream | null>
  // Injected by useCall so track-replacement stays centralized with
  // the other audio-sender swaps (mute toggles, device changes).
  swapAudioTrack: (track: MediaStreamTrack | null) => void
}

export interface UseCallNoiseReturn {
  aiNoiseSuppression: boolean
  aiNoiseStarting: boolean
  aiNoiseError: string | null
  toggleAiNoiseSuppression: () => Promise<void>
  dismissAiNoiseError: () => void
  // Called by useCall's cleanup / leave / join-failure paths to make
  // sure the pipeline is torn down even when toggling isn't the exit.
  disposeNoisePipeline: () => void
}

export function useCallNoise({ localStreamRef, swapAudioTrack }: UseCallNoiseOptions): UseCallNoiseReturn {
  const [aiNoiseSuppression, setAiNoiseSuppression] = useState<boolean>(false)
  const [aiNoiseStarting, setAiNoiseStarting] = useState<boolean>(false)
  const [aiNoiseError, setAiNoiseError] = useState<string | null>(null)
  const rnnoisePipelineRef = useRef<RnnoisePipeline | null>(null)

  const enable = useCallback(async (): Promise<void> => {
    if (rnnoisePipelineRef.current || aiNoiseStarting) return
    const localStream = localStreamRef.current
    const micTrack = localStream?.getAudioTracks()[0] || null
    if (!micTrack) {
      setAiNoiseError('Microphone not available yet — join the call first.')
      return
    }
    const ctx = getSharedAudioContext()
    if (!ctx) {
      setAiNoiseError('Browser audio engine unavailable.')
      return
    }
    ensureAudioContextRunning()
    setAiNoiseStarting(true)
    setAiNoiseError(null)
    try {
      // Dynamic import keeps the rnnoise loader (~11 KB) + WASM (~112 KB)
      // off CallPanelRuntime; the chunk only loads on the user's first
      // click. Subsequent toggles reuse the cached chunk.
      const { buildRnnoisePipeline } = await import('../utils/rnnoise')
      const pipeline = await buildRnnoisePipeline(ctx, micTrack)
      rnnoisePipelineRef.current = pipeline
      setAiNoiseSuppression(true)
      swapAudioTrack(pipeline.track)
    } catch (e) {
      console.warn('useCallNoise.enable failed', e)
      setAiNoiseError('Failed to load noise suppression.')
    } finally {
      setAiNoiseStarting(false)
    }
  }, [aiNoiseStarting, localStreamRef, swapAudioTrack])

  const disable = useCallback((): void => {
    const pipeline = rnnoisePipelineRef.current
    if (!pipeline) return
    rnnoisePipelineRef.current = null
    setAiNoiseSuppression(false)
    setAiNoiseError(null)
    const localStream = localStreamRef.current
    const micTrack = localStream?.getAudioTracks()[0] || null
    swapAudioTrack(micTrack)
    pipeline.dispose()
  }, [localStreamRef, swapAudioTrack])

  const toggleAiNoiseSuppression = useCallback(async (): Promise<void> => {
    if (rnnoisePipelineRef.current) disable()
    else await enable()
  }, [disable, enable])

  const dismissAiNoiseError = useCallback((): void => setAiNoiseError(null), [])

  // Invoked from useCall cleanup / leave / join-failure paths. Disposes
  // without flipping the audio sender back to mic — callers handle that
  // through their own tear-down (e.g., stopping the local stream entirely).
  const disposeNoisePipeline = useCallback((): void => {
    const pipeline = rnnoisePipelineRef.current
    if (!pipeline) return
    rnnoisePipelineRef.current = null
    try { pipeline.dispose() } catch { /* ignore */ }
    setAiNoiseSuppression(false)
  }, [])

  return {
    aiNoiseSuppression,
    aiNoiseStarting,
    aiNoiseError,
    toggleAiNoiseSuppression,
    dismissAiNoiseError,
    disposeNoisePipeline,
  }
}
