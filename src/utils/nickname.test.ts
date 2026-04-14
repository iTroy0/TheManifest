import { describe, it, expect } from 'vitest'
import { generateNickname } from './nickname'

describe('generateNickname', () => {
  it('matches the expected shape', () => {
    const nick = generateNickname()
    expect(nick).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{1,4}$/)
  })
  it('produces a non-empty string', () => {
    expect(generateNickname().length).toBeGreaterThan(0)
  })
  it('varies across calls (with high probability)', () => {
    const samples = new Set(Array.from({ length: 20 }, () => generateNickname()))
    expect(samples.size).toBeGreaterThan(1)
  })
})
