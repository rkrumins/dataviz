import GithubSlugger, { slug as githubSlug } from 'github-slugger'

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
type MarkdownLine =
  | { kind: 'heading'; id: string; text: string; level: number }
  | { kind: 'line'; text: string; inFence: boolean }

/** Every line of the page, with each heading resolved to its anchor id. */
function* walkMarkdown(md: string): Generator<MarkdownLine> {
  const slugger = new GithubSlugger()
  let inFence = false
  for (const raw of md.split('\n')) {
    const fence = /^\s*```/.test(raw)
    if (fence) inFence = !inFence
    if (inFence || fence) {
      yield { kind: 'line', text: raw, inFence: true }
      continue
    }
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
    if (!m) {
      yield { kind: 'line', text: raw, inFence: false }
      continue
    }
    const text = headingText(m[2])
    yield { kind: 'heading', id: slugger.slug(text), text, level: m[1].length }
  }
}

function* walkHeadings(md: string): Generator<{ id: string; text: string; level: number }> {
  for (const line of walkMarkdown(md)) {
    if (line.kind === 'heading') yield line
  }
}

/** One part of a page, from one heading to the next at the same depth or above. */
export interface MarkdownSection {
  /** Heading anchor id; empty for the part before the first h2. */
  id: string
  /** Heading text; the page's h1 (or nothing) for the opening part. */
  heading: string
  level: 1 | 2 | 3
  /** The section's markdown outside code fences. */
  prose: string
  /** The text inside its code fences. */
  code: string
}

/**
 * Split a page into its h2 and h3 sections, with the ids the rendered
 * headings get, so a search hit can link straight to the right one.
 * Deeper headings stay inside their section; their text joins its prose.
 */
export function splitSections(md: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  let current: MarkdownSection = { id: '', heading: '', level: 1, prose: '', code: '' }
  const prose: string[] = []
  const code: string[] = []
  const close = () => {
    current.prose = prose.join('\n')
    current.code = code.join('\n')
    if (current.id === '' && !current.heading && !current.prose.trim() && !current.code.trim()) return
    sections.push(current)
  }
  for (const line of walkMarkdown(md)) {
    if (line.kind === 'heading' && line.level === 1 && sections.length === 0 && current.id === '') {
      current.heading = line.text
      continue
    }
    if (line.kind === 'heading' && (line.level === 2 || line.level === 3)) {
      close()
      prose.length = 0
      code.length = 0
      current = { id: line.id, heading: line.text, level: line.level, prose: '', code: '' }
      continue
    }
    if (line.kind === 'heading') prose.push(line.text)
    else if (line.inFence) {
      if (!/^\s*```/.test(line.text)) code.push(line.text)
    } else prose.push(line.text)
  }
  close()
  return sections
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

/**
 * The anchor an FAQ answer renders under, from its question as written —
 * the docs FAQ page and the guide hub give each question this id, and
 * search links to it.
 */
export function faqAnchor(question: string): string {
  return `faq-${githubSlug(question.replace(/\{brand(Short)?\}/g, 'brand'))}`
}
