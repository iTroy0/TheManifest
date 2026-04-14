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
  it('rejects malformed input', () => {
    expect(safeUrl('not a url')).toBe('#')
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
})
