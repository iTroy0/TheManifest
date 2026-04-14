// Strip directory prefixes, dangerous control characters, and leading/
// trailing whitespace or dots. Returns "download" if the input sanitises
// to an empty string. Caps at 255 bytes to stay within filesystem limits.
export function sanitizeFileName(name: string): string {
  const stripped = name
    .replace(/^.*[\\/]/, '')              // drop path prefix
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')  // reserved/control chars → _
    .replace(/^[\s.]+|[\s.]+$/g, '')      // trim whitespace & dots
  return stripped.slice(0, 255) || 'download'
}
