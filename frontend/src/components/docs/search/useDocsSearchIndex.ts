/**
 * Full-text search index for the in-app Documentation + User Guide.
 *
 * Builds a lightweight in-memory index ONCE — lazily, on first real use —
 * by loading every doc and guide Markdown file (in parallel), stripping the
 * Markdown down to plain text, and remembering per-entry headings/body. The
 * built index is cached at module scope so a remount is instant and the
 * markdown is never re-fetched.
 *
 * Scoring is intentionally tiny and dependency-free (see `runSearch`):
 *   title match  >  heading match  >  body frequency
 * Queries are case-insensitive and multi-term (every term must appear
 * somewhere in the entry — AND-ish).
 */
import { useCallback, useEffect, useState } from 'react'
import { docEntries, getSectionById } from '@/components/docs/docsConfig'
import { guideEntries, getGuideSection } from '@/components/guide/guideConfig'

// ── Public types ───────────────────────────────────────────────────

export type DocsSearchArea = 'docs' | 'guide'

/** One piece of a snippet — `hit` segments are the matched terms to bold. */
export interface SnippetSegment {
  text: string
  hit: boolean
}

export interface DocsSearchResult {
  area: DocsSearchArea
  slug: string
  /** Raw title (may carry `{brand}` tokens — interpolate before display). */
  title: string
  sectionLabel: string
  /** Best-matching ~160-char window, pre-split for highlighting. */
  snippet: SnippetSegment[]
  score: number
}

// ── Internal index shape ───────────────────────────────────────────

interface IndexEntry {
  area: DocsSearchArea
  slug: string
  title: string
  titleLower: string
  sectionLabel: string
  headingsLower: string
  /** Plain-text body, original case (used to render snippets). */
  body: string
  bodyLower: string
}

// ── Markdown → plain text ──────────────────────────────────────────

/**
 * Strip Markdown syntax to searchable plain text. Headings are also returned
 * separately so they can be weighted higher during scoring. Not a real parser
 * — a handful of ordered regex passes, which is plenty for short docs.
 */
function extractPlainText(md: string): { body: string; headings: string } {
  const headings: string[] = []

  let s = md
    // fenced code blocks — drop entirely (noise for prose search)
    .replace(/```[\s\S]*?```/g, ' ')
    // front-matter fence at the top, if any
    .replace(/^---[\s\S]*?---/, ' ')

  // ATX headings — capture text, keep it inline too
  s = s.replace(/^#{1,6}\s+(.*)$/gm, (_m, h: string) => {
    const clean = h.trim()
    if (clean) headings.push(clean)
    return ` ${clean} `
  })

  s = s
    // images ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // links [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // inline code `code` → code
    .replace(/`([^`]*)`/g, '$1')
    // emphasis / strike markers
    .replace(/[*_~]{1,3}/g, '')
    // leading blockquote / list / ordered markers
    .replace(/^\s{0,3}(?:>|[-*+]|\d+\.)\s+/gm, '')
    // table cell pipes
    .replace(/\|/g, ' ')
    // table separator rows (---|:--: etc.)
    .replace(/^[\s:|-]+$/gm, ' ')
    // stray html tags
    .replace(/<[^>]+>/g, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()

  return { body: s, headings: headings.join(' ') }
}

// ── Module-scope cache (survives remounts) ─────────────────────────

let cachedIndex: IndexEntry[] | null = null
let indexPromise: Promise<IndexEntry[]> | null = null

async function buildIndex(): Promise<IndexEntry[]> {
  const docTasks = docEntries.map(async (e): Promise<IndexEntry> => {
    const mod = await e.importFn()
    const { body, headings } = extractPlainText(mod.default)
    return {
      area: 'docs',
      slug: e.slug,
      title: e.title,
      titleLower: e.title.toLowerCase(),
      sectionLabel: getSectionById(e.section)?.label ?? 'Documentation',
      headingsLower: headings.toLowerCase(),
      body,
      bodyLower: body.toLowerCase(),
    }
  })

  const guideTasks = guideEntries.map(async (e): Promise<IndexEntry> => {
    const mod = await e.importFn()
    const { body, headings } = extractPlainText(mod.default)
    return {
      area: 'guide',
      slug: e.slug,
      title: e.title,
      titleLower: e.title.toLowerCase(),
      sectionLabel: getGuideSection(e.section)?.label ?? 'User Guide',
      headingsLower: headings.toLowerCase(),
      body,
      bodyLower: body.toLowerCase(),
    }
  })

  return Promise.all([...docTasks, ...guideTasks])
}

/** Kick off (or reuse) the single build. Guards against double-loading. */
function getIndex(): Promise<IndexEntry[]> {
  if (!indexPromise) {
    indexPromise = buildIndex().then((idx) => {
      cachedIndex = idx
      return idx
    })
  }
  return indexPromise
}

// ── Scoring helpers ────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split a query into lowercase alphanumeric terms. */
function tokenize(q: string): string[] {
  return q.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count++
    from = idx + needle.length
  }
  return count
}

const SNIPPET_WINDOW = 160
const SNIPPET_LEAD = 32 // chars of context kept before the anchor match

/**
 * Build a highlighted snippet: the ~160-char body window covering the most
 * distinct matched terms, pre-split into `{ text, hit }` segments.
 */
function buildSnippet(body: string, bodyLower: string, terms: string[]): SnippetSegment[] {
  interface Occ {
    start: number
    end: number
    term: string
  }

  const occs: Occ[] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const idx = bodyLower.indexOf(term, from)
      if (idx === -1) break
      occs.push({ start: idx, end: idx + term.length, term })
      from = idx + term.length
    }
  }

  // No term appears in the body (e.g. matched only the title) → lead excerpt.
  if (occs.length === 0) {
    const text = body.slice(0, SNIPPET_WINDOW)
    return [{ text: body.length > SNIPPET_WINDOW ? `${text}…` : text, hit: false }]
  }

  occs.sort((a, b) => a.start - b.start)

  // Pick the anchor whose forward window covers the most distinct terms.
  let anchor = occs[0]
  let bestCoverage = 0
  for (const cand of occs) {
    const winEnd = cand.start + SNIPPET_WINDOW
    const seen = new Set<string>()
    for (const o of occs) {
      if (o.start > winEnd) break
      if (o.start >= cand.start) seen.add(o.term)
    }
    if (seen.size > bestCoverage) {
      bestCoverage = seen.size
      anchor = cand
    }
  }

  const start = Math.max(0, anchor.start - SNIPPET_LEAD)
  const end = Math.min(body.length, start + SNIPPET_WINDOW)

  // Re-split the chosen window around the matches that fall inside it.
  const segments: SnippetSegment[] = []
  let cursor = start
  for (const o of occs) {
    if (o.start >= end) break
    if (o.end <= cursor) continue // fully before cursor / overlapping — skip
    if (o.start < cursor) continue // partial overlap with prior hit — skip
    if (o.start > cursor) segments.push({ text: body.slice(cursor, o.start), hit: false })
    segments.push({ text: body.slice(o.start, Math.min(o.end, end)), hit: true })
    cursor = Math.min(o.end, end)
  }
  if (cursor < end) segments.push({ text: body.slice(cursor, end), hit: false })

  // Ellipses for a trimmed window.
  if (start > 0 && segments.length && !segments[0].hit) {
    segments[0] = { text: `…${segments[0].text}`, hit: false }
  } else if (start > 0) {
    segments.unshift({ text: '…', hit: false })
  }
  if (end < body.length) {
    const last = segments[segments.length - 1]
    if (last && !last.hit) segments[segments.length - 1] = { text: `${last.text}…`, hit: false }
    else segments.push({ text: '…', hit: false })
  }

  return segments
}

// ── The ranked search ──────────────────────────────────────────────

const MAX_RESULTS = 20

function runSearch(index: IndexEntry[], rawQuery: string): DocsSearchResult[] {
  const terms = tokenize(rawQuery)
  if (terms.length === 0) return []

  const phrase = rawQuery.trim().toLowerCase()
  const results: DocsSearchResult[] = []

  for (const entry of index) {
    let score = 0
    let allPresent = true

    for (const term of terms) {
      let termScore = 0

      if (entry.titleLower.includes(term)) {
        termScore += 100
        // word-boundary / prefix bonus — a real word, not a fragment
        if (new RegExp(`\\b${escapeRegExp(term)}`).test(entry.titleLower)) {
          termScore += 30
        }
      }
      if (entry.headingsLower.includes(term)) {
        termScore += 40
      }
      // body frequency, capped so a long doc can't dominate on repetition
      termScore += Math.min(countOccurrences(entry.bodyLower, term), 15) * 2

      if (termScore === 0) {
        allPresent = false
        break
      }
      score += termScore
    }

    if (!allPresent || score === 0) continue

    // Exact multi-word phrase in the title is a strong signal.
    if (terms.length > 1 && phrase && entry.titleLower.includes(phrase)) {
      score += 80
    }

    results.push({
      area: entry.area,
      slug: entry.slug,
      title: entry.title,
      sectionLabel: entry.sectionLabel,
      snippet: buildSnippet(entry.body, entry.bodyLower, terms),
      score,
    })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, MAX_RESULTS)
}

// ── Hook ───────────────────────────────────────────────────────────

export interface UseDocsSearchIndex {
  ready: boolean
  search: (query: string) => DocsSearchResult[]
}

/**
 * Lazily builds the docs/guide search index on mount (reusing the module
 * cache if already built) and exposes a synchronous `search`.
 */
export function useDocsSearchIndex(): UseDocsSearchIndex {
  const [ready, setReady] = useState(cachedIndex !== null)

  useEffect(() => {
    if (cachedIndex) {
      setReady(true)
      return
    }
    let alive = true
    getIndex().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const search = useCallback(
    (query: string): DocsSearchResult[] => {
      if (!cachedIndex) return []
      return runSearch(cachedIndex, query)
    },
    // Re-created once the index is ready so consumers recompute against it.
    [ready],
  )

  return { ready, search }
}
