// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const FRAME_SIZE = 480

// Single shared HEAPF32 used by both the WASM stub and assertions. Real
// buildRnnoisePipeline copies samples into HEAPF32 at inputPtr, then reads
// outputPtr after _rnnoise_process_frame. The stub identity-copies (with a
// scale fingerprint) so tests can verify the slide / clamp / scale paths.
let heap: Float32Array
const FAKE_INPUT_PTR = 0
const FAKE_OUTPUT_PTR = FRAME_SIZE * 4

vi.mock('@jitsi/rnnoise-wasm', () => ({
  createRNNWasmModule: () => {
    heap = new Float32Array(FRAME_SIZE * 2)
    return {
      ready: Promise.resolve(),
      _rnnoise_create: () => 1,
      _rnnoise_destroy: vi.fn(),
      _malloc: (size: number) => (size === FRAME_SIZE * 4 ? FAKE_INPUT_PTR : FAKE_OUTPUT_PTR),
      _free: vi.fn(),
      _rnnoise_process_frame: vi.fn((_state: number, outPtr: number, inPtr: number) => {
        // Identity copy from input frame to output frame, scaled by 1.0.
        const inOff = inPtr / 4
        const outOff = outPtr / 4
        for (let i = 0; i < FRAME_SIZE; i++) heap[outOff + i] = heap[inOff + i]
      }),
      get HEAPF32() { return heap },
    }
  },
}))

vi.mock('@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url', () => ({ default: 'blob:wasm-stub' }))

// AudioContext stub. Only what buildRnnoisePipeline actually calls.
class FakeProcessor {
  onaudioprocess: ((e: AudioProcessingEvent) => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeSource {
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeDestination {
  stream: MediaStream
  constructor() {
    const stop = vi.fn()
    this.stream = {
      getAudioTracks: () => [{ stop } as unknown as MediaStreamTrack],
      getTracks: () => [{ stop } as unknown as MediaStreamTrack],
    } as unknown as MediaStream
  }
}
class FakeAudioContext {
  createMediaStreamSource = vi.fn(() => new FakeSource())
  createScriptProcessor = vi.fn(() => new FakeProcessor())
  createMediaStreamDestination = vi.fn(() => new FakeDestination())
}

function fakeMicTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack
}

// Mints a synthetic AudioProcessingEvent. inputBuffer.getChannelData returns
// the provided samples; outputBuffer.getChannelData returns a writable buffer
// the test inspects after the callback runs.
function makeEvent(input: Float32Array): { event: AudioProcessingEvent; outBuf: Float32Array } {
  const outBuf = new Float32Array(input.length)
  const event = {
    inputBuffer: { getChannelData: () => input },
    outputBuffer: { getChannelData: () => outBuf },
  } as unknown as AudioProcessingEvent
  return { event, outBuf }
}

beforeEach(() => { heap = new Float32Array(FRAME_SIZE * 2) })
afterEach(() => { vi.restoreAllMocks() })

describe('buildRnnoisePipeline', () => {
  it('exposes a denoised track from the destination stream', async () => {
    const { buildRnnoisePipeline } = await import('./rnnoise')
    const ctx = new FakeAudioContext() as unknown as AudioContext
    const pipeline = await buildRnnoisePipeline(ctx, fakeMicTrack())
    expect(pipeline.track).toBeDefined()
    expect(typeof pipeline.dispose).toBe('function')
    pipeline.dispose()
  })

  it('clamps samples to int16 range so loud audio does not wrap', async () => {
    const { buildRnnoisePipeline } = await import('./rnnoise')
    const ctx = new FakeAudioContext() as unknown as AudioContext
    await buildRnnoisePipeline(ctx, fakeMicTrack())

    const processor = (ctx.createScriptProcessor as ReturnType<typeof vi.fn>).mock.results[0].value as FakeProcessor
    expect(processor.onaudioprocess).not.toBeNull()

    // Samples deliberately outside [-1, 1] — must clamp not wrap.
    const input = new Float32Array(FRAME_SIZE)
    for (let i = 0; i < FRAME_SIZE; i++) input[i] = i % 2 === 0 ? 5 : -5
    const { event, outBuf } = makeEvent(input)
    processor.onaudioprocess!(event)

    // Int16 range is asymmetric: positive clamps to 32767 → ÷32768 ≈ 0.99997,
    // negative clamps to -32768 → ÷32768 = exactly -1.0. Identity pass via
    // the WASM stub means the output mirrors the clamped input.
    const POS = 32767 / 32768
    const NEG = -1
    for (let i = 0; i < FRAME_SIZE; i++) {
      const expected = i % 2 === 0 ? POS : NEG
      expect(outBuf[i]).toBeCloseTo(expected, 5)
    }
  })

  it('round-trips in-range samples with negligible loss', async () => {
    const { buildRnnoisePipeline } = await import('./rnnoise')
    const ctx = new FakeAudioContext() as unknown as AudioContext
    await buildRnnoisePipeline(ctx, fakeMicTrack())
    const processor = (ctx.createScriptProcessor as ReturnType<typeof vi.fn>).mock.results[0].value as FakeProcessor

    const input = new Float32Array(FRAME_SIZE)
    for (let i = 0; i < FRAME_SIZE; i++) input[i] = Math.sin(i / 10) * 0.5
    const { event, outBuf } = makeEvent(input)
    processor.onaudioprocess!(event)

    // ×32768 then ÷32768 = identity within float rounding.
    for (let i = 0; i < FRAME_SIZE; i++) expect(outBuf[i]).toBeCloseTo(input[i], 4)
  })

  it('pads the output with silence while the slide accumulator warms up', async () => {
    const { buildRnnoisePipeline } = await import('./rnnoise')
    const ctx = new FakeAudioContext() as unknown as AudioContext
    await buildRnnoisePipeline(ctx, fakeMicTrack())
    const processor = (ctx.createScriptProcessor as ReturnType<typeof vi.fn>).mock.results[0].value as FakeProcessor

    // Send less than FRAME_SIZE samples — no full frame yet, so no
    // _rnnoise_process_frame call should fire and the output should be
    // entirely silent (zero-padded tail).
    const input = new Float32Array(100).fill(0.5)
    const { event, outBuf } = makeEvent(input)
    processor.onaudioprocess!(event)

    for (let i = 0; i < outBuf.length; i++) expect(outBuf[i]).toBe(0)
  })

  it('dispose is idempotent and tears down audio nodes on first call', async () => {
    const { buildRnnoisePipeline } = await import('./rnnoise')
    const ctx = new FakeAudioContext() as unknown as AudioContext
    const pipeline = await buildRnnoisePipeline(ctx, fakeMicTrack())

    const source = (ctx.createMediaStreamSource as ReturnType<typeof vi.fn>).mock.results[0].value as FakeSource
    const processor = (ctx.createScriptProcessor as ReturnType<typeof vi.fn>).mock.results[0].value as FakeProcessor

    pipeline.dispose()
    pipeline.dispose()
    pipeline.dispose()

    // First dispose tears down nodes; subsequent calls early-return.
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(processor.disconnect).toHaveBeenCalledTimes(1)
    expect(processor.onaudioprocess).toBeNull()
  })
})
