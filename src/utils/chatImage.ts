import type { ImagePreview } from '../hooks/useChatInteraction'

export class ImageTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageTooLargeError'
  }
}

const GIF_MAX_BYTES = 3 * 1024 * 1024
const COMPRESS_MAX_DIM = 2000
const COMPRESS_QUALITY = 0.92

export async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let { width, height } = img
        if (width > COMPRESS_MAX_DIM || height > COMPRESS_MAX_DIM) {
          const ratio = Math.min(COMPRESS_MAX_DIM / width, COMPRESS_MAX_DIM / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', COMPRESS_QUALITY))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

// GIFs go through unchanged (animated frames would die in <canvas>); other
// images are recompressed to a JPEG data URI. Throws ImageTooLargeError
// for oversize GIFs so the caller can surface the right user message.
export async function prepareImage(
  file: File,
  createTrackedBlobUrl: (blob: Blob) => string,
): Promise<ImagePreview> {
  if (file.type === 'image/gif') {
    if (file.size > GIF_MAX_BYTES) {
      throw new ImageTooLargeError('GIF is too large (max 3 MB)')
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const url = createTrackedBlobUrl(new Blob([bytes], { type: file.type }))
    return { url, bytes, mime: file.type }
  }
  const dataUri = await compressImage(file)
  const bytes = Uint8Array.from(atob(dataUri.split(',')[1]), c => c.charCodeAt(0))
  return { url: dataUri, bytes, mime: 'image/jpeg' }
}
