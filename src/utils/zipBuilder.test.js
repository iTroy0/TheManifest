import { describe, it, expect } from 'vitest'

// Extract sanitizeName for testing — it's not exported, so we replicate it
function sanitizeName(name) {
  name = name.replace(/^.*[\\/]/, '')
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, '_')
  name = name.replace(/^[\s.]+|[\s.]+$/g, '')
  return name || 'file'
}

describe('ZIP Filename Sanitization', () => {
  it('strips path traversal (../)', () => {
    expect(sanitizeName('../../../etc/passwd')).toBe('passwd')
  })

  it('strips nested traversal (foo/../../bar)', () => {
    expect(sanitizeName('foo/../../bar.txt')).toBe('bar.txt')
  })

  it('strips Windows absolute path', () => {
    expect(sanitizeName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe')
  })

  it('strips Unix absolute path', () => {
    expect(sanitizeName('/etc/shadow')).toBe('shadow')
  })

  it('replaces null bytes', () => {
    expect(sanitizeName('file\x00.txt')).toBe('file_.txt')
  })

  it('replaces control characters', () => {
    expect(sanitizeName('file\x01\x02\x1f.txt')).toBe('file___.txt')
  })

  it('replaces special characters (<>:"|?*)', () => {
    expect(sanitizeName('file<>:"|?*.txt')).toBe('file_______.txt')
  })

  it('strips leading dots', () => {
    expect(sanitizeName('...')).toBe('file')
  })

  it('strips trailing dots and spaces', () => {
    expect(sanitizeName('file.txt...')).toBe('file.txt')
    expect(sanitizeName('file.txt   ')).toBe('file.txt')
  })

  it('returns "file" for empty input', () => {
    expect(sanitizeName('')).toBe('file')
  })

  it('preserves normal filenames', () => {
    expect(sanitizeName('photo.jpg')).toBe('photo.jpg')
    expect(sanitizeName('My Document (1).pdf')).toBe('My Document (1).pdf')
  })

  it('preserves unicode filenames', () => {
    expect(sanitizeName('日本語ファイル.txt')).toBe('日本語ファイル.txt')
    expect(sanitizeName('émojis 🎉.png')).toBe('émojis 🎉.png')
  })

  it('handles XSS attempt', () => {
    // </script> has a slash, so regex strips everything before it → "script>.zip" → "script_.zip"
    expect(sanitizeName('<script>alert(1)</script>.zip')).toBe('script_.zip')
  })
})
