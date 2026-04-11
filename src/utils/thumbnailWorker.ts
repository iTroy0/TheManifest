const workerCode = `
self.onmessage = async function(e) {
  const { id, imageBlob, maxDim } = e.data;

  try {
    const bitmap = await createImageBitmap(imageBlob);
    const ratio = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1);
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
    const reader = new FileReader();
    reader.onload = () => {
      self.postMessage({ id, success: true, dataUrl: reader.result });
    };
    reader.readAsDataURL(blob);
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message });
  }
};
`

interface PendingTask {
  resolve: (value: string) => void
  reject: (reason: Error) => void
}

let worker: Worker | null = null
let pendingTasks = new Map<number, PendingTask>()
let taskId = 0

function getWorker(): Worker | null {
  if (worker) return worker

  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    worker = new Worker(url)

    worker.onmessage = (e: MessageEvent<{ id: number; success: boolean; dataUrl: string; error: string }>) => {
      const { id, success, dataUrl, error } = e.data
      const task = pendingTasks.get(id)
      if (task) {
        pendingTasks.delete(id)
        if (success) {
          task.resolve(dataUrl)
        } else {
          task.reject(new Error(error))
        }
      }
    }

    worker.onerror = (_err: ErrorEvent) => {
      // Worker failed, fall back to main thread
      console.warn('Thumbnail worker error, falling back to main thread')
      worker = null
    }

    return worker
  } catch {
    // Workers not supported, return null
    return null
  }
}

// Generate thumbnail using Web Worker (non-blocking)
export async function generateThumbnailAsync(file: File, maxDim = 80): Promise<string> {
  const w = getWorker()

  if (w) {
    return new Promise<string>((resolve, reject) => {
      const id = ++taskId
      pendingTasks.set(id, { resolve, reject })
      w.postMessage({ id, imageBlob: file, maxDim })

      // Timeout after 10s
      setTimeout(() => {
        if (pendingTasks.has(id)) {
          pendingTasks.delete(id)
          reject(new Error('Thumbnail generation timeout'))
        }
      }, 10000)
    })
  } else {
    // Fallback to main thread
    return generateThumbnailSync(file, maxDim)
  }
}

// Synchronous fallback for browsers without OffscreenCanvas/Worker support
export async function generateThumbnailSync(file: File, maxDim = 80): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const ratio = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1)
  const w = Math.round(bitmap.width * ratio)
  const h = Math.round(bitmap.height * ratio)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  ;(canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.5)
}

// Generate video thumbnail from first frame
export async function generateVideoThumbnail(file: File, maxDim = 80): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    const url = URL.createObjectURL(file)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      video.src = ''
      video.load()
      URL.revokeObjectURL(url)
      reject(new Error('Video thumbnail timeout'))
    }, 5000)

    video.onloadeddata = () => {
      video.currentTime = Math.min(1, video.duration / 4) // Seek to 25% or 1s
    }

    video.onseeked = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const ratio = Math.min(maxDim / video.videoWidth, maxDim / video.videoHeight, 1)
        const w = Math.round(video.videoWidth * ratio)
        const h = Math.round(video.videoHeight * ratio)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        ;(canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(video, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/jpeg', 0.5))
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }

    video.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      URL.revokeObjectURL(url)
      reject(new Error('Video load failed'))
    }

    video.src = url
    video.load()
  })
}

export async function generateTextPreview(file: File, maxChars = 200): Promise<string | null> {
  try {
    const text = await file.slice(0, maxChars + 100).text()
    return text.slice(0, maxChars) + (text.length > maxChars ? '...' : '')
  } catch {
    return null
  }
}

export interface PreviewResult {
  type: 'image' | 'video' | 'text'
  data: string | null
}

// Auto-detect file type and generate appropriate preview
export async function generatePreview(file: File, maxDim = 80): Promise<PreviewResult | null> {
  const type = file.type || ''

  if (type.startsWith('image/')) {
    try {
      return { type: 'image', data: await generateThumbnailAsync(file, maxDim) }
    } catch {
      return null
    }
  }

  if (type.startsWith('video/')) {
    try {
      return { type: 'video', data: await generateVideoThumbnail(file, maxDim) }
    } catch {
      return null
    }
  }

  if (type.startsWith('text/') || type === 'application/json' || type === 'application/javascript') {
    try {
      return { type: 'text', data: await generateTextPreview(file) }
    } catch {
      return null
    }
  }

  return null
}

// Batch generate thumbnails with concurrency limit
export async function generateThumbnailsBatch(files: File[], maxDim = 80, concurrency = 3): Promise<(string | null)[]> {
  const results: (string | null)[] = new Array(files.length).fill(null)
  let index = 0

  async function processNext(): Promise<void> {
    while (index < files.length) {
      const i = index++
      const file = files[i]

      if (file.type?.startsWith('image/') && file instanceof File) {
        try {
          results[i] = await generateThumbnailAsync(file, maxDim)
        } catch {
          // Skip failed thumbnails
        }
      }
    }
  }

  // Run workers in parallel
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, files.length); i++) {
    workers.push(processNext())
  }

  await Promise.all(workers)
  return results
}

// Cleanup
export function terminateThumbnailWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
    pendingTasks.clear()
  }
}
