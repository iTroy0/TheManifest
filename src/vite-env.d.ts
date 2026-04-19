/// <reference types="vite/client" />

declare module '@fontsource-variable/inter'
declare module '@fontsource-variable/jetbrains-mono'

declare module '@jitsi/rnnoise-wasm' {
  interface RnnModule {
    _rnnoise_create(): number
    _rnnoise_destroy(state: number): void
    _rnnoise_process_frame(state: number, output: number, input: number): number
    _malloc(size: number): number
    _free(ptr: number): void
    HEAPF32: Float32Array
    HEAPU8: Uint8Array
    ready: Promise<void>
  }
  interface ModuleOpts {
    locateFile?: (path: string) => string
  }
  export function createRNNWasmModule(opts?: ModuleOpts): RnnModule
  export function createRNNWasmModuleSync(opts?: ModuleOpts): RnnModule
}

declare module '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url' {
  const url: string
  export default url
}
