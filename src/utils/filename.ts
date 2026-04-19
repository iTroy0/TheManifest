// Strip directory prefixes, dangerous control characters, and leading/
// trailing whitespace or dots. Returns "download" if the input sanitises
// to an empty string. Caps at 255 bytes to stay within filesystem limits.
// Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) get a `_`
// prefix so StreamSaver / `a[download]` writes don't fail with IO errors.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeFileName(name: string): string {
  const stripped = name
    .replace(/^.*[\\/]/, '')              // drop path prefix
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')  // reserved/control chars → _
    .replace(/^[\s.]+|[\s.]+$/g, '')      // trim whitespace & dots
  if (!stripped) return 'download'
  const dotIdx = stripped.indexOf('.')
  const base = dotIdx === -1 ? stripped : stripped.slice(0, dotIdx)
  const out = WINDOWS_RESERVED.test(base) ? `_${stripped}` : stripped
  return out.slice(0, 255) || 'download'
}
