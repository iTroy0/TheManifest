import { generateVideoThumbnail, generateTextPreview, generateThumbnailsBatch } from './thumbnailWorker'
import { FileEntry, ManifestData } from '../types'

// Build the manifest payload sent to receivers on connect. Generates
// thumbnails and text previews in parallel so a large batch of files
// doesn't serialise on the main thread.
export async function buildManifestData(files: File[], chatOnly: boolean): Promise<ManifestData> {
  const thumbnails = await generateThumbnailsBatch(files, 80, 3)
  const fileEntries: FileEntry[] = await Promise.all(files.map(async (f, i) => {
    const entry: FileEntry = { name: f.name, size: f.size, type: f.type }
    if (thumbnails[i]) {
      entry.thumbnail = thumbnails[i]
    } else if (f.type?.startsWith('video/') && f instanceof File) {
      try { entry.thumbnail = await generateVideoThumbnail(f, 80) } catch {}
    } else if (f.type?.startsWith('text/') || f.type === 'application/json') {
      try { entry.textPreview = await generateTextPreview(f, 150) ?? undefined } catch {}
    }
    return entry
  }))

  return {
    type: 'manifest',
    chatOnly,
    files: fileEntries,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    sentAt: new Date().toISOString(),
  }
}
