/**
 * Message batcher for reducing network overhead
 * Batches multiple messages/reactions sent within a short time window
 */
export class MessageBatcher {
  constructor(sendFn, delayMs = 50) {
    this.sendFn = sendFn
    this.delayMs = delayMs
    this.queue = []
    this.timer = null
  }

  // Add a message to the batch queue
  add(message) {
    this.queue.push(message)
    
    // If this is the first message, start the timer
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs)
    }
  }

  // Send all queued messages
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.queue.length === 0) return

    if (this.queue.length === 1) {
      // Single message - send directly
      try { this.sendFn(this.queue[0]) } catch {}
    } else {
      // Multiple messages - send as batch
      try {
        this.sendFn({
          type: 'batch',
          messages: this.queue,
          count: this.queue.length
        })
      } catch {}
    }

    this.queue = []
  }

  // Immediately send without batching (for important messages)
  sendImmediate(message) {
    this.flush() // Flush any pending first
    try { this.sendFn(message) } catch {}
  }

  // Clean up
  destroy() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queue = []
  }
}

/**
 * Reaction deduplicator - prevents duplicate reactions in quick succession
 */
export class ReactionDeduplicator {
  constructor(windowMs = 500) {
    this.windowMs = windowMs
    this.recent = new Map() // key: `${msgId}-${emoji}` -> timestamp
  }

  // Check if this reaction was recently sent
  isDuplicate(msgId, emoji) {
    const key = `${msgId}-${emoji}`
    const lastTime = this.recent.get(key)
    const now = Date.now()

    if (lastTime && now - lastTime < this.windowMs) {
      return true
    }

    this.recent.set(key, now)
    
    // Cleanup old entries
    if (this.recent.size > 100) {
      const cutoff = now - this.windowMs * 2
      for (const [k, t] of this.recent) {
        if (t < cutoff) this.recent.delete(k)
      }
    }

    return false
  }

  clear() {
    this.recent.clear()
  }
}
