import { describe, it, expect } from 'vitest'
import { groupMessages } from './groupMessages'
import type { ChatMessage } from '../../types'

function msg(from: string, time: number, text = ''): ChatMessage {
  return { from, time, text, self: from === 'You' }
}

describe('groupMessages', () => {
  it('returns empty array for empty input', () => {
    expect(groupMessages([])).toEqual([])
  })

  it('wraps a single message in one group', () => {
    const groups = groupMessages([msg('A', 0, 'hi')])
    expect(groups).toHaveLength(1)
    expect(groups[0].from).toBe('A')
    expect(groups[0].messages).toHaveLength(1)
    expect(groups[0].messages[0].text).toBe('hi')
  })

  it('groups consecutive messages from the same author within 60s', () => {
    const groups = groupMessages([
      msg('A', 1_000),
      msg('A', 5_000),
      msg('A', 30_000),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].messages).toHaveLength(3)
    expect(groups[0].lastTime).toBe(30_000)
  })

  it('starts a new group when the gap exceeds 60s', () => {
    const groups = groupMessages([
      msg('A', 0),
      msg('A', 60_001),
    ])
    expect(groups).toHaveLength(2)
  })

  it('uses sliding 60s gap, not absolute window from first message', () => {
    // 0 → 50s (group), 50s → 100s (still group, gap = 50s)
    const groups = groupMessages([
      msg('A', 0),
      msg('A', 50_000),
      msg('A', 100_000),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].messages).toHaveLength(3)
  })

  it('separates groups by author', () => {
    const groups = groupMessages([
      msg('A', 0),
      msg('B', 1_000),
      msg('A', 2_000),
    ])
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.from)).toEqual(['A', 'B', 'A'])
  })

  it('never groups system messages, even consecutive ones', () => {
    const groups = groupMessages([
      msg('system', 0, 'joined'),
      msg('system', 100, 'kicked'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].isSystem).toBe(true)
    expect(groups[1].isSystem).toBe(true)
  })

  it('breaks an author chain when a system message appears between', () => {
    const groups = groupMessages([
      msg('A', 0),
      msg('system', 100, 'X joined'),
      msg('A', 200),
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].from).toBe('A')
    expect(groups[1].isSystem).toBe(true)
    expect(groups[2].from).toBe('A')
  })

  it('preserves the original message index across groups', () => {
    const groups = groupMessages([
      msg('A', 0),
      msg('B', 1_000),
      msg('A', 2_000),
      msg('A', 3_000),
    ])
    const allIndices = groups.flatMap(g => g.messages.map(m => m.index))
    expect(allIndices).toEqual([0, 1, 2, 3])
  })

  it('marks self/isSystem on the group level', () => {
    const groups = groupMessages([
      msg('You', 0, 'hi'),
      msg('Other', 100, 'hello'),
      msg('system', 200, 'X left'),
    ])
    expect(groups[0].self).toBe(true)
    expect(groups[0].isSystem).toBe(false)
    expect(groups[1].self).toBe(false)
    expect(groups[1].isSystem).toBe(false)
    expect(groups[2].isSystem).toBe(true)
  })
})
