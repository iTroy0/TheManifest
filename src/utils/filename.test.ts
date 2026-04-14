import { describe, it, expect } from 'vitest'
import { sanitizeFileName } from './filename'

describe('sanitizeFileName', () => {
  it('strips unix directory prefixes', () => {
    expect(sanitizeFileName('/home/user/report.pdf')).toBe('report.pdf')
  })
  it('strips windows directory prefixes', () => {
    expect(sanitizeFileName('C:\\Users\\Foo\\report.pdf')).toBe('report.pdf')
  })
  it('replaces reserved characters with underscore', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt')
  })
  it('trims leading and trailing dots and spaces', () => {
    expect(sanitizeFileName('  ..file.txt..  ')).toBe('file.txt')
  })
  it('falls back to "download" on empty input', () => {
    expect(sanitizeFileName('   ')).toBe('download')
    expect(sanitizeFileName('///')).toBe('download')
  })
  it('truncates at 255 chars', () => {
    const long = 'a'.repeat(300) + '.txt'
    expect(sanitizeFileName(long).length).toBeLessThanOrEqual(255)
  })
})
