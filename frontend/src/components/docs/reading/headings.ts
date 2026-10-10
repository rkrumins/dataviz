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
 * Every heading in document order with the id rehype-slug gives it. We replay
 * github-slugger over *every* heading — the same instance rehype-slug uses — so
 * the ids (and any duplicate "-1" suffixes) match the rendered anchors exactly.
 * Fenced code is skipped so a `#` comment inside a block never registers as a
 * heading.
 */
function* walkHeadings(md: string): Generator<{ id: string; text: string; level: number }> {
  const slugger = new GithubSlugger()
  let inFence = false
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) inFence = !inFence
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
    if (!m) continue
    const text = headingText(m[2])
    yield { id: slugger.slug(text), text, level: m[1].length }
  }
}

/** Build the "On this page" outline: h2 and h3, for a richer, indented rail. */
export function extractHeadings(md: string): Heading[] {
  const out: Heading[] = []
  for (const h of walkHeadings(md)) {
    if (h.level === 2 || h.level === 3) out.push({ id: h.id, text: h.text, level: h.level as 2 | 3 })
  }
  return out
}

/** The anchor id of every heading on the page, at any level. */
export function headingIds(md: string): Set<string> {
  return new Set(Array.from(walkHeadings(md), (h) => h.id))
}
