import type { ChatMessage } from '../../types'

export interface GroupedMessage extends ChatMessage {
  index: number
}

export interface MessageGroup {
  from: string
  self: boolean
  isSystem: boolean
  messages: GroupedMessage[]
  lastTime: number
}

const GROUP_WINDOW_MS = 60_000

// Groups consecutive messages from the same author within a 60s window.
// System messages never group. Order preserved.
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let currentGroup: MessageGroup | null = null

  messages.forEach((msg, i) => {
    const isSystemMsg = msg.from === 'system'
    const timeDiff = currentGroup ? msg.time - currentGroup.lastTime : Infinity
    const sameAuthor = currentGroup && currentGroup.from === msg.from
    const shouldGroup = sameAuthor && timeDiff < GROUP_WINDOW_MS && !isSystemMsg

    if (shouldGroup) {
      currentGroup!.messages.push({ ...msg, index: i })
      currentGroup!.lastTime = msg.time
    } else {
      if (currentGroup) groups.push(currentGroup)
      currentGroup = {
        from: msg.from,
        self: msg.self,
        isSystem: isSystemMsg,
        messages: [{ ...msg, index: i }],
        lastTime: msg.time,
      }
    }
  })
  if (currentGroup) groups.push(currentGroup)
  return groups
}
