export function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s'
  return formatBytes(bytesPerSecond) + '/s'
}

export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.ceil(seconds % 60)
  return `${m}m ${s}s`
}
