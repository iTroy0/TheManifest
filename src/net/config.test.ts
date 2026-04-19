import { describe, it, expect } from 'vitest'
import { getMaxConnections } from './config'

describe('getMaxConnections', () => {
  it('returns the legacy default of 20 when deviceMemory is undefined', () => {
    expect(getMaxConnections(undefined)).toBe(20)
  })

  it('caps high-RAM workstations at 30', () => {
    expect(getMaxConnections(8)).toBe(30)
    expect(getMaxConnections(16)).toBe(30)
    expect(getMaxConnections(32)).toBe(30)
  })

  it('keeps the legacy 20 for 4 GB devices', () => {
    expect(getMaxConnections(4)).toBe(20)
    expect(getMaxConnections(7.5)).toBe(20)
  })

  it('drops to 12 for 2-3.99 GB devices', () => {
    expect(getMaxConnections(2)).toBe(12)
    expect(getMaxConnections(3)).toBe(12)
  })

  it('drops to 6 for 1-1.99 GB devices', () => {
    expect(getMaxConnections(1)).toBe(6)
    expect(getMaxConnections(1.5)).toBe(6)
  })

  it('drops to 4 for low-RAM devices (< 1 GB)', () => {
    expect(getMaxConnections(0.5)).toBe(4)
    expect(getMaxConnections(0.25)).toBe(4)
    expect(getMaxConnections(0)).toBe(4)
  })
})
