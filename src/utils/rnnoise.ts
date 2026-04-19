// RNNoise neural noise suppression. Lazy-loaded on first use; the WASM
// blob (~112 KB) + loader (~12 KB) doesn't enter the initial bundle.
// v1 runs in the main thread via ScriptProcessorNode (deprecated but
// cross-browser); a future pass can move processing into an AudioWorklet
// for tighter latency by shipping the WASM bytes to the worklet over
// the port.
//
// Why ScriptProcessorNode over AudioWorklet today: the @jitsi/rnnoise-wasm
// loader uses Emscripten patterns (document.currentScript + fetch) that
// AudioWorkletGlobalScope can't satisfy. Pre-fetching the bytes and
// instantiating inside the worklet is feasible but requires bypassing
// the lib's loader path — not justified for v1.
//
// Why @jitsi/rnnoise-wasm vs @shiguredo/rnnoise-wasm: the shiguredo build
// embeds the WASM as base64 inside the JS file, producing a ~4.8 MB chunk.
// jitsi keeps WASM as a separate ~112 KB file fetched at module init,
// total ~125 KB combined — about 38× smaller. Lower-level API (raw
// _malloc / HEAPF32 buffer management) but the wrapping is contained
// in this file.

import { createRNNWasmModule } from '@jitsi/rnnoise-wasm'
import wasmUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url'

// RNNoise is locked to 480 samples per frame at 48 kHz (10 ms frame).
const FRAME_SIZE = 480

interface RnnoiseModule {
  _rnnoise_create(): number
  _rnnoise_destroy(state: number): void
  _rnnoise_process_frame(state: number, output: number, input: number): number
  _malloc(size: number): number
  _free(ptr: number): void
  HEAPF32: Float32Array
  ready: Promise<void>
}

let modulePromise: Promise<RnnoiseModule> | null = null

async function loadRnnoiseModule(): Promise<RnnoiseModule> {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    // Emscripten module factory: locateFile lets us hand it the Vite-emitted
    // hashed wasm URL so it loads from the correct asset path.
    const mod = createRNNWasmModule({
      locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
    }) as unknown as RnnoiseModule
    await mod.ready
    return mod
  })()
  return modulePromise
}

export interface RnnoisePipeline {
  // The denoised audio track. Connect to peer connections via swapAudioTrack.
  track: MediaStreamTrack
  // Idempotent. Disconnects WebAudio nodes, frees WASM allocations, and
  // closes the destination stream. Safe to call multiple times.
  dispose(): void
}

// Wraps a raw mic track with RNNoise denoising. Returns a new MediaStreamTrack
// that downstream code can publish in place of the raw mic. Caller owns the
// AudioContext lifecycle — pass a long-lived context (e.g., the call's shared
// AudioContext) so we don't create one per-toggle.
export async function buildRnnoisePipeline(
  audioCtx: AudioContext,
  micTrack: MediaStreamTrack,
): Promise<RnnoisePipeline> {
  const mod = await loadRnnoiseModule()
  const denoiseState = mod._rnnoise_create()
  // RNNoise reads + writes via WASM heap pointers. Allocate input + output
  // scratch buffers up front (one frame each, 4 bytes per Float32 sample).
  const bufBytes = FRAME_SIZE * 4
  const inputPtr = mod._malloc(bufBytes)
  const outputPtr = mod._malloc(bufBytes)

  // ScriptProcessorNode buffer must be a power of 2 between 256 and 16384.
  // 4096 @ 48 kHz ≈ 85 ms — long enough that we always have ≥ FRAME_SIZE
  // samples per callback after accumulating across boundaries, short enough
  // to keep total round-trip latency well under perceptible voice delay.
  const BUFFER_SIZE = 4096
  const source = audioCtx.createMediaStreamSource(new MediaStream([micTrack]))
  const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
  const destination = audioCtx.createMediaStreamDestination()

  // Sliding accumulator. Audio arrives in BUFFER_SIZE chunks but RNNoise
  // wants exactly FRAME_SIZE samples per call, so we buffer the tail of one
  // callback into the start of the next.
  const accumulator = new Float32Array(BUFFER_SIZE + FRAME_SIZE)
  let accLen = 0
  const outputAcc = new Float32Array(BUFFER_SIZE + FRAME_SIZE)
  let outAccLen = 0

  processor.onaudioprocess = (event: AudioProcessingEvent): void => {
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    // RNNoise expects samples in the range [-32768, 32767] (Int16 PCM
    // semantics) packed in a Float32. WebAudio gives us [-1, 1] floats,
    // so scale up before feeding RNNoise and back down after.
    for (let i = 0; i < input.length; i++) {
      accumulator[accLen + i] = input[i] * 32768
    }
    accLen += input.length

    // Process every full frame currently in the accumulator. Each
    // processed frame's output is appended to outputAcc.
    while (accLen >= FRAME_SIZE) {
      // Write the input frame into WASM heap at inputPtr.
      const heapInputView = mod.HEAPF32.subarray(
        inputPtr / 4, inputPtr / 4 + FRAME_SIZE,
      )
      heapInputView.set(accumulator.subarray(0, FRAME_SIZE))
      mod._rnnoise_process_frame(denoiseState, outputPtr, inputPtr)
      // Read the denoised frame back from WASM heap at outputPtr and
      // append to outputAcc, scaling back to [-1, 1].
      const heapOutputView = mod.HEAPF32.subarray(
        outputPtr / 4, outputPtr / 4 + FRAME_SIZE,
      )
      for (let i = 0; i < FRAME_SIZE; i++) {
        outputAcc[outAccLen + i] = heapOutputView[i] / 32768
      }
      outAccLen += FRAME_SIZE
      // Slide remaining input samples to the front of the accumulator.
      accumulator.copyWithin(0, FRAME_SIZE, accLen)
      accLen -= FRAME_SIZE
    }

    // Drain outputAcc into the audio output buffer. If we haven't built up
    // enough denoised samples yet (warmup or processing slower than realtime),
    // pad the tail with silence to avoid leaking garbage. The first 1-2
    // callbacks emit silence while the accumulator fills.
    const drainLen = Math.min(output.length, outAccLen)
    for (let i = 0; i < drainLen; i++) output[i] = outputAcc[i]
    for (let i = drainLen; i < output.length; i++) output[i] = 0
    if (drainLen > 0) {
      outputAcc.copyWithin(0, drainLen, outAccLen)
      outAccLen -= drainLen
    }
  }

  source.connect(processor)
  processor.connect(destination)

  let disposed = false
  return {
    track: destination.stream.getAudioTracks()[0],
    dispose(): void {
      if (disposed) return
      disposed = true
      try { source.disconnect() } catch { /* ignore */ }
      try { processor.disconnect() } catch { /* ignore */ }
      processor.onaudioprocess = null
      try { mod._rnnoise_destroy(denoiseState) } catch { /* ignore */ }
      try { mod._free(inputPtr) } catch { /* ignore */ }
      try { mod._free(outputPtr) } catch { /* ignore */ }
      try { destination.stream.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    },
  }
}
