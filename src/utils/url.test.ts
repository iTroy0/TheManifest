import { describe, it, expect } from 'vitest'
import { safeUrl, URL_REGEX } from './url'

describe('safeUrl', () => {
  it('normalises http URLs', () => {
    expect(safeUrl('http://example.com')).toBe('http://example.com/')
  })
  it('normalises https URLs', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com/')
  })
  it('rejects javascript: URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
  })
  it('rejects data: URLs', () => {
    expect(safeUrl('data:text/html,<script>')).toBe('#')
  })
  it('rejects file: URLs', () => {
    expect(safeUrl('file:///etc/passwd')).toBe('#')
  })
  it('rejects ftp: URLs', () => {
    expect(safeUrl('ftp://example.com')).toBe('#')
  })
  it('rejects malformed input', () => {
    expect(safeUrl('not a url')).toBe('#')
    expect(safeUrl('')).toBe('#')
    expect(safeUrl('://broken')).toBe('#')
  })
  it('rejects embedded user credentials (phishing vector)', () => {
    expect(safeUrl('https://evil@real-bank.com')).toBe('#')
    expect(safeUrl('https://user:pw@real-bank.com')).toBe('#')
    expect(safeUrl('http://attacker@paypal.com/login')).toBe('#')
  })
  it('preserves query + fragment', () => {
    expect(safeUrl('https://x.com/a?b=1#frag')).toBe('https://x.com/a?b=1#frag')
  })
})

describe('URL_REGEX', () => {
  it('matches https URLs inside text', () => {
    const text = 'visit https://example.com/foo now'
    expect(text.match(URL_REGEX)?.[0]).toBe('https://example.com/foo')
  })
  it('excludes trailing punctuation', () => {
    expect('see https://example.com/path.'.match(URL_REGEX)?.[0]).toBe('https://example.com/path')
  })
  it('rejects non-http(s) schemes in linkification', () => {
    expect(URL_REGEX.test('javascript:alert(1)')).toBe(false)
    expect(URL_REGEX.test('data:text/html,x')).toBe(false)
    expect(URL_REGEX.test('ftp://example.com')).toBe(false)
  })
  it('split yields [text, url, text, url, ...] with capturing group', () => {
    const parts = 'see https://a.com and https://b.org done'.split(URL_REGEX)
    expect(parts).toEqual(['see ', 'https://a.com', ' and ', 'https://b.org', ' done'])
  })
  it('split returns single segment when no URL present', () => {
    expect('hello world'.split(URL_REGEX)).toEqual(['hello world'])
  })
  it('does not match url-ish plain text', () => {
    expect('x://y'.split(URL_REGEX)).toEqual(['x://y'])
  })
})
