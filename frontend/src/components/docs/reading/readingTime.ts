/**
 * Estimate reading time from raw markdown. Strips code fences and markup so a
 * long code sample doesn't inflate the count, then assumes ~200 words/minute
 * (comfortable prose speed). Always at least "1 min".
 */
export function readingTime(md: string): string {
  const prose = md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ') // images / links
    .replace(/[#>*_~|-]/g, ' ')
  const words = prose.split(/\s+/).filter(Boolean).length
  const mins = Math.max(1, Math.round(words / 200))
  return `${mins} min`
}
