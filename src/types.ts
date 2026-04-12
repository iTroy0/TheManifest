export interface ChatMessage {
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
