import { URL_REGEX, safeUrl } from '../../utils/url'

interface LinkifyProps {
  text: string
}

// Renders text with http(s) URLs converted to safe anchor tags.
export default function Linkify({ text }: LinkifyProps) {
  if (!text) return null
  const parts = text.split(URL_REGEX)
  return (
    <>
      {parts.map((part, i) =>
        URL_REGEX.test(part)
          ? <a key={i} href={safeUrl(part)} target="_blank" rel="noopener noreferrer" className="text-info underline hover:text-info/80 break-all">{part}</a>
          : part
      )}
    </>
  )
}
