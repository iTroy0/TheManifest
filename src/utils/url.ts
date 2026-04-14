// URL regex for linkification — http(s) only; trailing punctuation is
// excluded so "visit https://x.com." captures just the URL, not the period.
export const URL_REGEX = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?\])}>])/

// Defence-in-depth: even though URL_REGEX already restricts to http(s),
// route unknown protocols through # so a future regex relaxation can't
// produce a javascript:/data: href.
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    return '#'
  } catch {
    return '#'
  }
}
