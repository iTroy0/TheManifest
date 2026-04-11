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

  it('returns -- for negative input', () => expect(formatTime(-5)).toBe('--'))
  it('rounds up 0.1 seconds to 1s', () => expect(formatTime(0.1)).toBe('1s'))
  it('rounds up 0.9 seconds to 1s', () => expect(formatTime(0.9)).toBe('1s'))
  it('formats 3599 seconds as 59m 59s', () => expect(formatTime(3599)).toBe('59m 59s'))
  it('formats 3600 seconds as 60m 0s', () => expect(formatTime(3600)).toBe('60m 0s'))
})

describe('formatBytes edge cases', () => {
  it('handles negative input without crashing', () => {
    // Math.log of a negative is NaN; the function should return a string
    const result: string = formatBytes(-1)
    expect(typeof result).toBe('string')
  })

  it('handles fractional bytes (0.5)', () => {
    // formatBytes uses Math.floor(Math.log(0.5)/Math.log(1024)) which is -1 (negative index)
    // The function will return some string — verify it does not throw
    const result: string = formatBytes(0.5)
    expect(typeof result).toBe('string')
  })

  it('formats Number.MAX_SAFE_INTEGER without throwing', () => {
    const result: string = formatBytes(Number.MAX_SAFE_INTEGER)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatSpeed edge cases', () => {
  it('formats 512 B/s and includes B/s suffix', () => {
    const result: string = formatSpeed(512)
    expect(result).toContain('B/s')
    expect(result).toMatch(/512/)
  })
})
