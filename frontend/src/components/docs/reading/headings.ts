import GithubSlugger from 'github-slugger'

export interface Heading {
  id: string
  text: string
  level: 2 | 3
}

/**
 * Strip the inline markdown that doesn't survive into a heading's rendered
 * text, so the slug ids match what rehype-slug produces.
 */
function headingText(raw: string): string {
  return raw
    .replace(/`/g, '')
    .replace(/\*\*?/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .trim()
}

/**
 * Build the "On this page" outline. We replay github-slugger over *every*
 * heading in document order — the same instance rehype-slug uses — so the ids
 * (and any duplicate "-1" suffixes) match the rendered anchors exactly. We
 * surface h2 and h3 for a richer, indented rail; fenced code is skipped so a
 * `#` comment inside a block never registers as a heading.
 */
export function extractHeadings(md: string): Heading[] {
  const slugger = new GithubSlugger()
  const out: Heading[] = []
  let inFence = false
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) inFence = !inFence
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
    if (!m) continue
    const text = headingText(m[2])
    const id = slugger.slug(text)
    const level = m[1].length
    if (level === 2 || level === 3) out.push({ id, text, level: level as 2 | 3 })
  }
  return out
}
