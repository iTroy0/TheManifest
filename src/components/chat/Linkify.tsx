import { URL_REGEX, safeUrl } from '../../utils/url'

interface LinkifyProps {
  text: string
}

// Renders text with http(s) URLs converted to safe anchor tags.
// URL_REGEX has a single capturing group, so `split` yields alternating
// [nonUrl, url, nonUrl, url, ...]. Odd indices are captures — no regex
// re-test needed (and avoids statefulness hazards with the shared regex).
export default function Linkify({ text }: LinkifyProps) {
  if (!text) return null
  const parts = text.split(URL_REGEX)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <a key={i} href={safeUrl(part)} target="_blank" rel="noopener noreferrer" className="text-info underline hover:text-info/80 break-all">{part}</a>
          : part
      )}
    </>
  )
}
