import { describe, it, expect } from 'vitest'
import {
  docEntries,
  docSections,
  docPersonas,
  docKeyJourneys,
  faqEntries,
} from './docsConfig'
import {
  guideEntries,
  guideSections,
  guidePersonas,
  keyJourneys,
  guideFaqs,
} from '@/components/guide/guideConfig'
import { filenameMap } from './MarkdownComponents'

/**
 * Documentation integrity — the guard against re-drift.
 *
 * The whole /docs and /guide surface is driven by two manifest files plus a
 * filename→slug map. Nothing else stops a doc from being renamed, a link from
 * going stale, or an entry from pointing at a file that no longer exists. This
 * suite makes those failures a red build instead of a 404 a user finds.
 *
 * It calls each entry's real `importFn` (the exact `@docs/…?raw` path the app
 * uses), so a missing/renamed markdown file fails here too.
 */

const docSlugs = new Set(docEntries.map((e) => e.slug))
const guideSlugs = new Set(guideEntries.map((e) => e.slug))
const docSectionIds = new Set(docSections.map((s) => s.id))
const guideSectionIds = new Set(guideSections.map((s) => s.id))
const guidePersonaIds = new Set(guidePersonas.map((p) => p.id))

// Valid in-app routes that are not manifest entries.
const EXTRA_DOC_ROUTES = new Set(['faq'])
const EXTRA_GUIDE_ROUTES = new Set<string>([])

// A route link is a bare `/docs/<slug>` / `/guide/<slug>` leaf — bounded by a
// link/quote/space delimiter, not followed by a further path segment or file
// extension. That excludes asset paths (/docs-assets/guide/x-hero.png) and
// absolute GitHub URLs (…/blob/main/docs/versioning/02-…md), which are external.
const DOC_LINK = /(?<=^|[("'\s>])\/docs\/([a-z0-9-]+)(?=$|[)#"'\s<])/g
const GUIDE_LINK = /(?<=^|[("'\s>])\/guide\/([a-z0-9-]+)(?=$|[)#"'\s<])/g
// Relative markdown link, e.g. ](./FILE.md#anchor) or ](sub/FILE.md). The char
// class excludes ':' so absolute http(s) URLs never match.
const MD_LINK = /\]\(\s*\.?\/?([A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\s*\)/g

function collectDeadLinks(content: string, where: string, errors: string[]): void {
  for (const m of content.matchAll(DOC_LINK)) {
    if (!docSlugs.has(m[1]) && !EXTRA_DOC_ROUTES.has(m[1])) {
      errors.push(`${where}: dead in-app link /docs/${m[1]}`)
    }
  }
  for (const m of content.matchAll(GUIDE_LINK)) {
    if (!guideSlugs.has(m[1]) && !EXTRA_GUIDE_ROUTES.has(m[1])) {
      errors.push(`${where}: dead in-app link /guide/${m[1]}`)
    }
  }
}

describe('docs manifest integrity', () => {
  it('doc and guide slugs are unique', () => {
    expect(docSlugs.size).toBe(docEntries.length)
    expect(guideSlugs.size).toBe(guideEntries.length)
  })

  it('every entry belongs to a declared section (and valid persona)', () => {
    expect(docEntries.filter((e) => !docSectionIds.has(e.section)).map((e) => e.slug)).toEqual([])
    expect(guideEntries.filter((e) => !guideSectionIds.has(e.section)).map((e) => e.slug)).toEqual([])
    expect(
      guideEntries.filter((e) => e.persona && !guidePersonaIds.has(e.persona)).map((e) => e.slug),
    ).toEqual([])
  })

  it('persona and key-journey slugs point to registered entries', () => {
    const docRefs = [...docPersonas.map((p) => p.startSlug), ...docKeyJourneys.map((j) => j.slug)]
    expect(docRefs.filter((s) => !docSlugs.has(s))).toEqual([])
    const guideRefs = [...guidePersonas.map((p) => p.startSlug), ...keyJourneys.map((j) => j.slug)]
    expect(guideRefs.filter((s) => !guideSlugs.has(s))).toEqual([])
  })

  it('every filenameMap target is a registered doc slug', () => {
    expect(Object.entries(filenameMap).filter(([, slug]) => !docSlugs.has(slug))).toEqual([])
  })
})

describe('docs content integrity', () => {
  it('every doc markdown loads, is non-empty, and its in-app links resolve', async () => {
    const errors: string[] = []
    for (const e of docEntries) {
      const content = (await e.importFn()).default
      expect(typeof content, `${e.slug} markdown missing`).toBe('string')
      expect(content.length, `${e.slug} markdown empty`).toBeGreaterThan(0)
      collectDeadLinks(content, `docs/${e.slug}`, errors)
    }
    expect(errors).toEqual([])
  })

  it('every guide markdown loads, is non-empty, and its in-app links resolve', async () => {
    const errors: string[] = []
    for (const e of guideEntries) {
      const content = (await e.importFn()).default
      expect(content.length, `${e.slug} markdown empty`).toBeGreaterThan(0)
      collectDeadLinks(content, `guide/${e.slug}`, errors)
    }
    expect(errors).toEqual([])
  })

  it('inline FAQ and guide-hub links resolve', () => {
    const errors: string[] = []
    for (const f of faqEntries) collectDeadLinks(f.answer, `faq:"${f.question.slice(0, 32)}"`, errors)
    for (const f of guideFaqs) collectDeadLinks(f.answer, `guideFaq:"${f.question.slice(0, 32)}"`, errors)
    expect(errors).toEqual([])
  })

  it('relative .md links in registered docs route in-app (present in filenameMap)', async () => {
    const errors: string[] = []
    for (const e of docEntries) {
      const content = (await e.importFn()).default
      for (const m of content.matchAll(MD_LINK)) {
        const base = m[1].split('/').pop() as string
        if (!(base in filenameMap)) {
          errors.push(`docs/${e.slug}: relative link "${m[1]}" is not in filenameMap → 404 in-app`)
        }
      }
    }
    expect(errors).toEqual([])
  })
})
