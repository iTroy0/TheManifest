import { describe, it, expect } from 'vitest'
import { formatBytes, formatSpeed, formatTime } from './formatBytes'

describe('formatBytes', () => {
  it('formats 0 bytes', () => expect(formatBytes(0)).toBe('0 B'))
  it('formats bytes', () => expect(formatBytes(500)).toBe('500 B'))
  it('formats KB', () => expect(formatBytes(1024)).toBe('1 KB'))
  it('formats MB', () => expect(formatBytes(1048576)).toBe('1 MB'))
  it('formats GB', () => expect(formatBytes(1073741824)).toBe('1 GB'))
  it('formats with decimals', () => expect(formatBytes(1536)).toBe('1.5 KB'))
})

describe('formatSpeed', () => {
  it('formats 0', () => expect(formatSpeed(0)).toBe('0 B/s'))
  it('appends /s', () => expect(formatSpeed(1048576)).toBe('1 MB/s'))
})

describe('formatTime', () => {
  it('returns -- for 0', () => expect(formatTime(0)).toBe('--'))
  it('returns -- for NaN', () => expect(formatTime(NaN)).toBe('--'))
  it('returns -- for Infinity', () => expect(formatTime(Infinity)).toBe('--'))
  it('formats seconds', () => expect(formatTime(30)).toBe('30s'))
  it('formats minutes', () => expect(formatTime(90)).toBe('1m 30s'))
  it('rounds up seconds', () => expect(formatTime(0.5)).toBe('1s'))
})
