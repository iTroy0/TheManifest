// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceRecorder } from './useVoiceRecorder'

// Minimal MediaRecorder stub. Drives the API surface useVoiceRecorder
// touches: start/stop, ondataavailable, onstop, state, mimeType, stream.
class FakeMediaRecorder {
  static isTypeSupported = vi.fn().mockReturnValue(true)
  state: 'inactive' | 'recording' = 'inactive'
  stream: MediaStream
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(stream: MediaStream, opts: { mimeType: string }) {
    this.stream = stream
    this.mimeType = opts.mimeType
  }
  start(_chunkMs?: number): void { this.state = 'recording' }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) })
    this.onstop?.()
  }
}

function fakeStream(): MediaStream {
  const stop = vi.fn()
  return { getTracks: () => [{ stop } as unknown as MediaStreamTrack] } as unknown as MediaStream
}

beforeEach(() => {
  vi.useFakeTimers()
  // Reset & install global stubs each test to keep cases isolated.
  ;(globalThis as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder = FakeMediaRecorder
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup() {
  const onClip = vi.fn()
  const onError = vi.fn()
  const createTrackedBlobUrl = vi.fn().mockReturnValue('blob:voice-stub')
  const onSent = vi.fn()
  const { result } = renderHook(() =>
    useVoiceRecorder({ onClip, onError, createTrackedBlobUrl, onSent }),
  )
  return { result, onClip, onError, createTrackedBlobUrl, onSent }
}

describe('useVoiceRecorder', () => {
  it('reports recording support when MediaRecorder advertises a mime', () => {
    const { result } = setup()
    expect(result.current.hasRecordingSupport).toBe(true)
  })

  it('start → tick → stop emits a clip with the elapsed duration', async () => {
    const { result, onClip, onSent, createTrackedBlobUrl } = setup()

    await act(async () => { await result.current.startRecording() })
    expect(result.current.isRecording).toBe(true)

    // Drive 3 ticks of the 1s timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(result.current.recordingTime).toBe(3)

    await act(async () => { result.current.stopRecording() })

    expect(onClip).toHaveBeenCalledOnce()
    const clip = onClip.mock.calls[0][0]
    expect(clip.duration).toBe(3)
    expect(clip.url).toBe('blob:voice-stub')
    expect(clip.mime).toMatch(/^audio\/webm/)
    expect(clip.bytes).toBeInstanceOf(Uint8Array)
    expect(onSent).toHaveBeenCalledOnce()
    expect(createTrackedBlobUrl).toHaveBeenCalledOnce()
    expect(result.current.isRecording).toBe(false)
  })

  it('stops automatically at MAX_RECORDING_SECS without overshoot', async () => {
    const { result, onClip } = setup()

    await act(async () => { await result.current.startRecording() })
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })

    expect(onClip).toHaveBeenCalledOnce()
    const clip = onClip.mock.calls[0][0]
    // After the cap-reorder fix the clip's reported duration matches the
    // last displayed second (179) rather than overshooting to MAX (180).
    expect(clip.duration).toBe(179)
    expect(result.current.isRecording).toBe(false)
  })

  it('cancelRecording wipes state without invoking onClip', async () => {
    const { result, onClip } = setup()

    await act(async () => { await result.current.startRecording() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    await act(async () => { result.current.cancelRecording() })

    expect(onClip).not.toHaveBeenCalled()
    expect(result.current.isRecording).toBe(false)
    expect(result.current.recordingTime).toBe(0)
  })

  it('routes mic permission errors through onError, then clears them', async () => {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    })

    const { result, onError, onClip } = setup()
    await act(async () => { await result.current.startRecording() })

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Microphone access denied/i))
    // After ERROR_HIDE_MS the error is reset to null.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(onError).toHaveBeenLastCalledWith(null)
    expect(onClip).not.toHaveBeenCalled()
    expect(result.current.isRecording).toBe(false)
  })
})
