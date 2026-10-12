/**
 * Full-text search over the in-app Documentation and User Guide.
 *
 * Every page is split into its opening and its h2/h3 sections, and every FAQ
 * answer is an entry of its own, so a hit can take the reader to the part of
 * the page that answers them rather than to the top of it. The index is
 * MiniSearch — BM25 ranking, prefix matching while you type, typo tolerance —
 * over terms from `terms.ts`, which drops filler words and folds plurals and
 * -ed/-ing forms together.
 *
 * Built once, lazily, the first time something asks for it, and cached at
 * module scope per brand: titles and headings carry `{brand}` tokens, and the
 * anchors the reader renders depend on the brand name they are filled with.
 */
import { useCallback, useEffect, useState } from 'react'
import MiniSearch from 'minisearch'
import { docEntries, faqEntries, getSectionById } from '@/components/docs/docsConfig'
import { guideEntries, guideFaqs, getGuideSection } from '@/components/guide/guideConfig'
import { faqAnchor, splitSections } from '@/components/docs/reading/headings'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand, useBrandingStore } from '@/store/branding'
import type { Branding } from '@/services/brandingService'
import { processTerm } from './terms'

// ── Public types ───────────────────────────────────────────────────

export type DocsSearchArea = 'docs' | 'guide'

/** One piece of a snippet — `hit` segments are the matched words to bold. */
export interface SnippetSegment {
  text: string
  hit: boolean
}

/** One searchable part: a page's opening, one of its sections, or an FAQ answer. */
export interface IndexEntry {
  id: string
  area: DocsSearchArea
  /** The page's slug; `faq` for a docs FAQ answer, `` for a guide FAQ answer (the hub). */
  slug: string
  kind: 'page' | 'section' | 'faq'
  /** The page's title, brand filled in. */
  pageTitle: string
  /** The section heading or the FAQ question; empty for a page's opening. */
  heading: string
  /** The heading's anchor id; empty for the top of the page. */
  anchor: string
  /** Where the page sits in its sidebar. */
  sectionLabel: string
  /** Plain text, for matching and snippets. */
  text: string
  /** Text inside code blocks, matched with a low weight. */
  code: string
  /** Where a hit takes the reader. */
  href: string
}

export interface DocsSearchResult {
  area: DocsSearchArea
  slug: string
  kind: IndexEntry['kind']
  /** The page's title, brand filled in. */
  title: string
  /** The section heading or FAQ question the hit is in, if not the page's opening. */
  heading?: string
  anchor?: string
  href: string
  sectionLabel: string
  /** A ~160-character window of the text around the matched words. */
  snippet: SnippetSegment[]
  /** The words the query matched, as index terms — for highlighting elsewhere. */
  terms: string[]
  score: number
}

export interface DocsSearchIndex {
  engine: MiniSearch<IndexEntry>
  entries: Map<string, IndexEntry>
  brandKey: string
}

export interface SearchOptions {
  /** Rank this area's pages first, other things being roughly equal. */
  area?: DocsSearchArea
  /** Only this area. */
  only?: DocsSearchArea
  /** Most pages to return. */
  limit?: number
  /** Most hits to return per page (sections of the same page). */
  perPage?: number
}

// ── Markdown → plain text ──────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

/**
 * Markdown prose → the text a reader sees. Not a parser: a few ordered
 * passes, enough for this repository's pages. Identifiers keep their
 * underscores (`ADMIN_PASSWORD`); only emphasis markers go.
 */
export function plainText(md: string): string {
  return decodeEntities(
    md
      // invisible reference-style comments, e.g. [screenshot-pending]: # "…"
      .replace(/^\s*\[[^\]]+\]:\s*#.*$/gm, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}(?:>\s?)+/gm, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/(^|[\s(])[*_](?=\S)/g, '$1')
      .replace(/(\S)[*_](?=[\s).,;:!?]|$)/g, '$1')
      .replace(/^[\s:|-]+$/gm, ' ')
      .replace(/\|/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Building ───────────────────────────────────────────────────────

function brandKey(brand: Branding): string {
  return `${brand.appName}\u0000${brand.shortName}`
}

function pageEntries(
  area: DocsSearchArea,
  slug: string,
  rawTitle: string,
  description: string,
  sectionLabel: string,
  markdown: string,
  brand: Branding,
): IndexEntry[] {
  const pageTitle = interpolateBrand(rawTitle, brand)
  const base = `/${area}/${slug}`
  return splitSections(interpolateBrand(markdown, brand)).map((s, i): IndexEntry => {
    const opening = s.id === ''
    const text = plainText(s.prose)
    return {
      id: `${area}:${slug}${opening ? '' : `#${s.id}`}:${i}`,
      area,
      slug,
      kind: opening ? 'page' : 'section',
      pageTitle,
      heading: opening ? '' : s.heading,
      anchor: s.id,
      sectionLabel,
      text: opening && description ? `${interpolateBrand(description, brand)} ${text}` : text,
      code: s.code,
      href: opening ? base : `${base}#${s.id}`,
    }
  })
}

/**
 * Names people search by that the pages don't always use. When an entry's
 * title or text says one, it is also findable by the others.
 */
const SYNONYMS: string[][] = [
  ['sso', 'single sign-on', 'single sign on'],
  ['kubernetes', 'k8s'],
  ['sign in', 'log in', 'login'],
  ['sign out', 'log out', 'logout'],
  ['rbac', 'roles and permissions'],
  ['mfa', 'multi-factor', '2fa'],
  ['database', 'db'],
  ['oidc', 'openid connect'],
  ['admin', 'administrator'],
]

function synonymsOf(text: string): string {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  const found: string[] = []
  for (const group of SYNONYMS) {
    if (group.some((name) => lower.includes(` ${name.replace(/[^\p{L}\p{N}]+/gu, ' ')} `))) {
      found.push(...group)
    }
  }
  return found.join(' ')
}

/** The searchable "title" of an entry: its own heading, or the page title for a page's opening. */
function ownTitle(entry: IndexEntry): string {
  return entry.kind === 'page' ? entry.pageTitle : entry.heading
}

/** Build an index from entries. Exported for tests and for callers that bring their own. */
export function indexFromEntries(entries: IndexEntry[], key = ''): DocsSearchIndex {
  const engine = new MiniSearch<IndexEntry>({
    fields: ['title', 'titleAlso', 'pageTitle', 'text', 'textAlso', 'code'],
    storeFields: ['area', 'kind'],
    // Sections also carry their page's title, weighted less, so "kubernetes
    // upgrade" finds the Upgrade section of the Kubernetes page.
    extractField: (entry, field) => {
      switch (field) {
        case 'title': return ownTitle(entry)
        case 'titleAlso': return synonymsOf(ownTitle(entry))
        case 'pageTitle': return entry.kind === 'page' ? '' : entry.pageTitle
        case 'textAlso': return synonymsOf(entry.text)
        default: return (entry as unknown as Record<string, string>)[field]
      }
    },
    processTerm,
  })
  engine.addAll(entries)
  return { engine, entries: new Map(entries.map((e) => [e.id, e])), brandKey: key }
}

async function buildIndex(brand: Branding): Promise<DocsSearchIndex> {
  const docTasks = docEntries.map(async (e) => {
    const md = (await e.importFn()).default
    return pageEntries('docs', e.slug, e.title, e.description ?? '',
      getSectionById(e.section)?.label ?? 'Documentation', md, brand)
  })
  const guideTasks = guideEntries.map(async (e) => {
    const md = (await e.importFn()).default
    return pageEntries('guide', e.slug, e.title, e.description ?? '',
      getGuideSection(e.section)?.label ?? 'User Guide', md, brand)
  })
  const pages = (await Promise.all([...docTasks, ...guideTasks])).flat()

  const faqs: IndexEntry[] = [
    ...faqEntries.map((f, i): IndexEntry => ({
      id: `docs:faq:${i}`, area: 'docs', slug: 'faq', kind: 'faq',
      pageTitle: 'FAQ', heading: interpolateBrand(f.question, brand), anchor: faqAnchor(f.question),
      sectionLabel: `FAQ · ${f.category}`, text: plainText(interpolateBrand(f.answer, brand)), code: '',
      href: `/docs/faq#${faqAnchor(f.question)}`,
    })),
    ...guideFaqs.map((f, i): IndexEntry => ({
      id: `guide:faq:${i}`, area: 'guide', slug: '', kind: 'faq',
      pageTitle: 'User Guide FAQ', heading: interpolateBrand(f.question, brand), anchor: faqAnchor(f.question),
      sectionLabel: 'FAQ', text: plainText(interpolateBrand(f.answer, brand)), code: '',
      href: `/guide#${faqAnchor(f.question)}`,
    })),
  ]
  return indexFromEntries([...pages, ...faqs], brandKey(brand))
}

let cache: { key: string; promise: Promise<DocsSearchIndex> } | null = null
let built: DocsSearchIndex | null = null

/**
 * The index for `brand` (the current brand by default), building it on
 * first use. Concurrent callers share one build.
 */
export function getIndex(brand: Branding = useBrandingStore.getState().branding): Promise<DocsSearchIndex> {
  const key = brandKey(brand)
  if (!cache || cache.key !== key) {
    const promise = buildIndex(brand).then((idx) => {
      if (cache?.key === key) built = idx
      return idx
    })
    cache = { key, promise }
  }
  return cache.promise
}

/** Start building the index without waiting for it — call on hover or focus. */
export function prefetchSearchIndex(): void {
  void getIndex()
}

// ── Searching ──────────────────────────────────────────────────────

const SNIPPET_WINDOW = 160
const SNIPPET_LEAD = 40
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

/** Split `text` into segments, marking the words whose index term is in `terms`. */
export function highlight(text: string, terms: Set<string>): SnippetSegment[] {
  const out: SnippetSegment[] = []
  let cursor = 0
  for (const m of text.matchAll(WORD)) {
    const term = processTerm(m[0])
    if (!term || !terms.has(term)) continue
    const start = m.index ?? 0
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false })
    out.push({ text: m[0], hit: true })
    cursor = start + m[0].length
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}

/** The window of `text` covering the most distinct matched words, highlighted. */
function snippet(text: string, terms: Set<string>): SnippetSegment[] {
  if (!text) return []
  const hits: { start: number; term: string }[] = []
  for (const m of text.matchAll(WORD)) {
    const term = processTerm(m[0])
    if (term && terms.has(term)) hits.push({ start: m.index ?? 0, term })
  }
  let start = 0
  if (hits.length) {
    let best = -1
    for (const h of hits) {
      const seen = new Set(hits.filter((o) => o.start >= h.start && o.start <= h.start + SNIPPET_WINDOW).map((o) => o.term))
      if (seen.size > best) {
        best = seen.size
        start = Math.max(0, h.start - SNIPPET_LEAD)
      }
    }
    // Start on a word boundary.
    if (start > 0) {
      const space = text.indexOf(' ', start)
      if (space !== -1 && space - start < 20) start = space + 1
    }
  }
  const end = Math.min(text.length, start + SNIPPET_WINDOW)
  const segments = highlight(text.slice(start, end), terms)
  if (start > 0) segments.unshift({ text: '…', hit: false })
  if (end < text.length) segments.push({ text: '…', hit: false })
  return segments
}

function prefix(term: string, i: number, all: string[]): boolean {
  // The word being typed is always a prefix; the others when long enough
  // that a prefix is unlikely to be an accident.
  return i === all.length - 1 || term.length >= 4
}

function fuzzy(term: string): number | boolean {
  // Typo tolerance in the shape search engines use: one edit from five
  // characters, two from eight. Shorter words are matched as written.
  return term.length >= 8 ? 2 : term.length >= 5 ? 1 : false
}

/**
 * Rank the index against `query`. Every query word must match (after typo
 * and prefix tolerance); when nothing does, the best partial matches are
 * returned instead. Hits are grouped by page — the best page first — with
 * up to `perPage` of each page's sections.
 */
export function runSearch(
  index: DocsSearchIndex,
  query: string,
  options: SearchOptions = {},
): DocsSearchResult[] {
  return searchWithMeta(index, query, options).results
}

/** `runSearch`, also saying whether it fell back to partial matches. */
export function searchWithMeta(
  index: DocsSearchIndex,
  query: string,
  { area, only, limit = 20, perPage = 1 }: SearchOptions = {},
): { results: DocsSearchResult[]; partial: boolean } {
  if (!query.trim()) return { results: [], partial: false }
  const run = (combineWith: 'AND' | 'OR') =>
    index.engine.search(query, {
      boost: { title: 6, titleAlso: 4, pageTitle: 2, text: 1, textAlso: 0.5, code: 0.3 },
      prefix,
      fuzzy,
      combineWith,
      filter: only ? (r) => r.area === only : undefined,
      // The area being read ranks first among near-equals, and a page's
      // opening edges out a short heading elsewhere that happens to repeat
      // the query: the page about the thing is the better answer.
      boostDocument: (_id, _term, stored) =>
        (area && stored?.area === area ? 1.35 : 1) * (stored?.kind === 'page' ? 1.15 : 1),
    })
  let raw = run('AND')
  const partial = raw.length === 0
  if (partial) raw = run('OR')

  const pages = new Map<string, DocsSearchResult[]>()
  for (const r of raw) {
    const entry = index.entries.get(String(r.id))
    if (!entry) continue
    const key = entry.kind === 'faq' ? entry.id : `${entry.area}:${entry.slug}`
    const group = pages.get(key) ?? []
    if (group.length >= perPage) continue
    const terms = new Set(r.terms)
    group.push({
      area: entry.area,
      slug: entry.slug,
      kind: entry.kind,
      title: entry.pageTitle,
      heading: entry.heading || undefined,
      anchor: entry.anchor || undefined,
      href: entry.href,
      sectionLabel: entry.sectionLabel,
      snippet: snippet(entry.text, terms),
      terms: r.terms,
      score: r.score,
    })
    pages.set(key, group)
  }
  // Map keeps insertion order, and results arrive best first, so each page
  // sits where its best hit ranked.
  return { results: Array.from(pages.values()).slice(0, limit).flat(), partial: partial && raw.length > 0 }
}

// ── Hook ───────────────────────────────────────────────────────────

export interface UseDocsSearchIndex {
  ready: boolean
  search: (query: string, options?: SearchOptions) => DocsSearchResult[]
  /** `search`, also saying whether the results are only partial matches. */
  searchMeta: (query: string, options?: SearchOptions) => { results: DocsSearchResult[]; partial: boolean }
}

/**
 * The search index for the current brand. Nothing is loaded until `enabled`
 * is true (it is by default); after that, `search` runs synchronously.
 */
export function useDocsSearchIndex(enabled = true): UseDocsSearchIndex {
  const brand = useBrand()
  const key = brandKey(brand)
  const [loaded, setLoaded] = useState<DocsSearchIndex | null>(null)
  // Built already — by this or any other caller — or built for this hook.
  const index = built?.brandKey === key ? built : loaded?.brandKey === key ? loaded : null

  useEffect(() => {
    if (!enabled || index) return
    let alive = true
    getIndex(brand).then((idx) => {
      if (alive) setLoaded(idx)
    })
    return () => {
      alive = false
    }
    // `key` stands for `brand`: a new brand object with the same names needs no rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, index])

  const search = useCallback(
    (query: string, options?: SearchOptions): DocsSearchResult[] => (index ? runSearch(index, query, options) : []),
    [index],
  )
  const searchMeta = useCallback(
    (query: string, options?: SearchOptions) =>
      index ? searchWithMeta(index, query, options) : { results: [], partial: false },
    [index],
  )

  return { ready: index !== null, search, searchMeta }
}
