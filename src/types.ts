export interface ChatMessage {
  // Stable per-message id. Used to target reactions so multiple messages with
  // colliding timestamps (e.g., two guests sending in the same ms) don't mix.
  // Optional for backward compat with messages received from older clients.
  id?: string
  text: string
  image?: string
  mime?: string
  duration?: number
  replyTo?: { text: string; from: string; time: number } | null
  from: string
  time: number
  self: boolean
  reactions?: Record<string, string[]>
}

export interface FileEntry {
  name: string
  size: number
  type: string
  thumbnail?: string
  textPreview?: string
}

export interface ManifestData {
  type: 'manifest'
  chatOnly: boolean
  files: FileEntry[]
  totalSize: number
  sentAt: string
}
