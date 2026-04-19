import { describe, it, expect } from 'vitest'
import { makeZip } from 'client-zip'

// Replicated rather than imported because `./zipBuilder` pulls in streamsaver
// at module-load and streamsaver immediately touches `document`, which the
// default Node test environment doesn't expose. The function under test is a
// pure string transform — kept in lockstep with `zipBuilder.ts:sanitizeName`.
function sanitizeName(name: string): string {
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

// ── M-j: client-zip backend correctness ───────────────────────────────────
// Byte-level checks against the raw zip stream produced by `client-zip`.
// We don't drive the createStreamingZip handle here (it depends on
// StreamSaver, which needs a ServiceWorker we can't host in jsdom) — but
// the wrapper's correctness collapses to client-zip's correctness, so the
// guarantees we care about (UTF-8 filename flag, valid local + central
// headers, declared sizes appearing in the central directory) are
// directly verifiable on the underlying library output.

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

function findSignature(bytes: Uint8Array, sig: number, start = 0): number {
  // Little-endian 4-byte signature scan.
  const a = sig & 0xff, b = (sig >> 8) & 0xff, c = (sig >> 16) & 0xff, d = (sig >> 24) & 0xff
  for (let i = start; i <= bytes.length - 4; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return i
  }
  return -1
}

describe('zip output byte format (client-zip)', () => {
  it('sets UTF-8 language-encoding flag (bit 11) for non-ASCII filename', async () => {
    const stream = makeZip([
      { input: 'hello', name: '日本語.txt' },
    ])
    const bytes = await streamToBytes(stream)

    // Local file header: 0x04034b50. Flag word at offset 6, little-endian.
    const lfh = findSignature(bytes, 0x04034b50)
    expect(lfh).toBe(0)
    const flag = bytes[lfh + 6] | (bytes[lfh + 7] << 8)
    expect(flag & 0x800).toBe(0x800)

    // Central directory header: 0x02014b50. Flag at offset 8, little-endian.
    const cd = findSignature(bytes, 0x02014b50)
    expect(cd).toBeGreaterThan(0)
    const cdFlag = bytes[cd + 8] | (bytes[cd + 9] << 8)
    expect(cdFlag & 0x800).toBe(0x800)

    // EOCD: 0x06054b50. Must exist at the tail.
    const eocd = findSignature(bytes, 0x06054b50)
    expect(eocd).toBeGreaterThan(0)
    expect(eocd).toBeLessThan(bytes.length)
  })

  it('produces a valid CJK filename round-trippable via TextDecoder', async () => {
    const name = '日本語ファイル.txt'
    const stream = makeZip([{ input: 'x', name }])
    const bytes = await streamToBytes(stream)

    const lfh = findSignature(bytes, 0x04034b50)
    const fnLen = bytes[lfh + 26] | (bytes[lfh + 27] << 8)
    const fnBytes = bytes.subarray(lfh + 30, lfh + 30 + fnLen)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(fnBytes)).toBe(name)
  })

  it('multi-entry archive emits one central directory record per entry', async () => {
    const stream = makeZip([
      { input: 'a', name: 'a.txt' },
      { input: 'bb', name: 'b.txt' },
      { input: 'ccc', name: 'c.txt' },
    ])
    const bytes = await streamToBytes(stream)

    let count = 0
    let pos = 0
    for (;;) {
      pos = findSignature(bytes, 0x02014b50, pos)
      if (pos === -1) break
      count++
      pos += 4
    }
    expect(count).toBe(3)
  })

  // Zip64 cannot be unit-tested without ≥4 GB of actual bytes — client-zip
  // gates on the running stream length (`e.o += BigInt(chunk.length)`), not
  // on any caller-declared size, so a fake byteLength override doesn't reach
  // the threshold. The library writes the Zip64 extended-info extra field
  // (0x0001) + EOCD64 record unconditionally when entry size ≥ 0xFFFFFFFF;
  // upstream test coverage at github.com/Touffy/client-zip is the
  // authoritative source for that branch. Pinned client-zip version in
  // package.json prevents a silent regression.
})
