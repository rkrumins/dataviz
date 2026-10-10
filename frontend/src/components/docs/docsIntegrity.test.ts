import { readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
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
  topJobs,
} from '@/components/guide/guideConfig'
import { filenameMap, rewriteDocLink } from './MarkdownComponents'
import { DOC_TYPES, getDocType } from './reading/DocTypeBadge'
import { headingIds } from './reading/headings'
import { getTour } from '@/features/tour/tours'
import { DEFAULT_BRANDING } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'

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
// absolute URLs that merely contain /docs/ (https://host/…/docs/x.md), which are external.
const DOC_LINK = /(?<=^|[("'\s>])\/docs\/([a-z0-9-]+)(?=$|[)#"'\s<])/g
const GUIDE_LINK = /(?<=^|[("'\s>])\/guide\/([a-z0-9-]+)(?=$|[)#"'\s<])/g
// Relative markdown link, e.g. ](./FILE.md#anchor), ](sub/FILE.md) or
// ](../FILE.md). The char class excludes ':' so absolute http(s) URLs never match.
const MD_LINK = /\]\(\s*([A-Za-z0-9_./-]+\.md(?:#[^)\s]*)?)\s*\)/g

// Each entry's markdown file, read from the configs' own import paths — the
// same parse `scripts/gen-doc-meta.mjs` does. An entry is a `slug` followed by
// its `section`, which keeps key-journey slugs (no section) out of the match.
function entryFiles(configFile: string): Map<string, string> {
  const src = readFileSync(configFile, 'utf8')
  const out = new Map<string, string>()
  const re = /slug:\s*'([^']+)',\s*\n\s*section:[\s\S]{0,600}?import\('@(docs|root)\/([^?']+\.md)/g
  for (const m of src.matchAll(re)) out.set(m[1], m[2] === 'docs' ? `docs/${m[3]}` : m[3])
  return out
}
const DOC_FILES = entryFiles(join(__dirname, 'docsConfig.ts'))
const GUIDE_FILES = entryFiles(join(__dirname, '..', 'guide', 'guideConfig.ts'))

const docContent = new Map<string, string>()
const guideContent = new Map<string, string>()
beforeAll(async () => {
  for (const e of docEntries) docContent.set(e.slug, (await e.importFn()).default)
  for (const e of guideEntries) guideContent.set(e.slug, (await e.importFn()).default)
})

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

/** Every page with where it lives, for checks that apply to both readers. */
function allPages(): { where: string; content: string }[] {
  return [
    ...docEntries.map((e) => ({ where: `docs/${e.slug}`, content: docContent.get(e.slug) ?? '' })),
    ...guideEntries.map((e) => ({ where: `guide/${e.slug}`, content: guideContent.get(e.slug) ?? '' })),
  ]
}

/** Drop fenced and inline code: what's inside them is shown, not interpreted. */
function proseOnly(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
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

  it('persona, key-journey and hub-job slugs point to registered entries', () => {
    const docRefs = [...docPersonas.map((p) => p.startSlug), ...docKeyJourneys.map((j) => j.slug)]
    expect(docRefs.filter((s) => !docSlugs.has(s))).toEqual([])
    const guideRefs = [
      ...guidePersonas.map((p) => p.startSlug),
      ...keyJourneys.map((j) => j.slug),
      ...topJobs.map((j) => j.slug),
    ]
    expect(guideRefs.filter((s) => !guideSlugs.has(s))).toEqual([])
  })

  it('every filenameMap target is a registered doc slug', () => {
    expect(Object.entries(filenameMap).filter(([, slug]) => !docSlugs.has(slug))).toEqual([])
  })

  it('every doc has a Diátaxis type, and every type names a registered doc', () => {
    expect(docEntries.filter((e) => !getDocType(e.slug)).map((e) => e.slug)).toEqual([])
    expect(Object.keys(DOC_TYPES).filter((s) => !docSlugs.has(s))).toEqual([])
  })

  it('every entry’s file is known to the link checks', () => {
    // A parse miss here would silently exempt that page from the link checks.
    expect([...docSlugs].filter((s) => !DOC_FILES.has(s))).toEqual([])
    expect([...guideSlugs].filter((s) => !GUIDE_FILES.has(s))).toEqual([])
  })

  it('repository-only files stay out of the readers', () => {
    // Both readers are public and ship in the static bundle. The debt register,
    // the pen-test pack and the release notes are for people with the repository.
    const REPO_ONLY = /(^|\/)TECHNICAL_DEBT\.md$|^docs\/(security|superpowers|audits)\/|RELEASE_NOTES_/
    const files = [...DOC_FILES.values(), ...GUIDE_FILES.values()]
    expect(files.filter((f) => REPO_ONLY.test(f))).toEqual([])
  })
})

describe('rewriteDocLink', () => {
  it('follows a relative link the way it resolves on disk, keeping its anchor', () => {
    expect(rewriteDocLink('DECISIONS.md#adr-018')).toBe('/docs/decisions#adr-018')
    expect(rewriteDocLink('../DATA_ARCHITECTURE.md')).toBe('/docs/data-architecture')
    expect(rewriteDocLink('docs/versioning/11-resync-at-any-scale.md')).toBe(
      '/docs/versioning-resync-at-any-scale',
    )
    // Exact paths only: another folder's README is not the versioning one.
    expect(rewriteDocLink('../examples/search-and-rules/README.md')).toBe(
      '../examples/search-and-rules/README.md',
    )
  })
})

describe('docs content integrity', () => {
  it('every doc markdown loads, is non-empty, and its in-app links resolve', () => {
    const errors: string[] = []
    for (const e of docEntries) {
      const content = docContent.get(e.slug)
      expect(typeof content, `${e.slug} markdown missing`).toBe('string')
      expect(content!.length, `${e.slug} markdown empty`).toBeGreaterThan(0)
      collectDeadLinks(content!, `docs/${e.slug}`, errors)
    }
    expect(errors).toEqual([])
  })

  it('every guide markdown loads, is non-empty, and its in-app links resolve', () => {
    const errors: string[] = []
    for (const e of guideEntries) {
      const content = guideContent.get(e.slug) ?? ''
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

  it('a relative .md link in a doc opens the page it points at on disk', () => {
    // The reader routes a relative link through filenameMap. Resolving to *some*
    // page is not enough: it has to be the file the link names, or a reader
    // following it lands on the wrong page.
    const errors: string[] = []
    for (const e of docEntries) {
      const file = DOC_FILES.get(e.slug)!
      for (const m of (docContent.get(e.slug) ?? '').matchAll(MD_LINK)) {
        const href = m[1]
        const onDisk = posix.normalize(posix.join(posix.dirname(file), href.split('#')[0]))
        const routed = rewriteDocLink(href)
        if (!routed.startsWith('/docs/')) {
          errors.push(`docs/${e.slug}: relative link "${href}" is not in filenameMap → 404 in-app`)
          continue
        }
        const slug = routed.slice('/docs/'.length).split('#')[0]
        if (DOC_FILES.get(slug) !== onDisk) {
          errors.push(`docs/${e.slug}: "${href}" names ${onDisk} but opens /docs/${slug}`)
        }
      }
    }
    expect(errors).toEqual([])
  })

  it('guide pages link by route, never by relative .md path', () => {
    // The guide renderer does not rewrite .md links; one would open a 404.
    const errors: string[] = []
    for (const e of guideEntries) {
      for (const m of (guideContent.get(e.slug) ?? '').matchAll(MD_LINK)) {
        errors.push(`guide/${e.slug}: relative link "${m[1]}" — use /guide/<slug> or /docs/<slug>`)
      }
    }
    expect(errors).toEqual([])
  })

  it('every guide page ends by pointing the reader on ("Where to next")', () => {
    // A guide page is one step on a path: it ends by saying where to go
    // next, so a reader is never left at a dead end.
    const missing = guideEntries
      .filter((e) => {
        const sections = [...proseOnly(guideContent.get(e.slug) ?? '').matchAll(/^## (.+)$/gm)]
        return sections.at(-1)?.[1].trim() !== 'Where to next'
      })
      .map((e) => `guide/${e.slug}`)
    expect(missing).toEqual([])
  })

  it('every anchor in a link matches a heading on the page it points at', () => {
    // Ids are what rehype-slug renders after {brand} is substituted. An anchor
    // must hold under any brand, so a link into a heading that carries {brand}
    // fails too: it would break the day the deployment is renamed.
    const brands = [DEFAULT_BRANDING, { ...DEFAULT_BRANDING, appName: 'Acme Lineage', shortName: 'AL' }]
    const idCache = new Map<string, Set<string>>()
    const idsOf = (key: string, md: string): Set<string> => {
      let ids = idCache.get(key)
      if (!ids) {
        const [a, b] = brands.map((brand) => headingIds(interpolateBrand(md, brand)))
        ids = new Set([...a].filter((id) => b.has(id)))
        idCache.set(key, ids)
      }
      return ids
    }
    const target = (area: string, slug: string): string | undefined =>
      area === 'docs' ? docContent.get(slug) : guideContent.get(slug)

    const errors: string[] = []
    const check = (where: string, area: string, slug: string, anchor: string) => {
      const md = target(area, slug)
      if (md === undefined) return // dead links are reported by the tests above
      const id = decodeURIComponent(anchor)
      if (!idsOf(`${area}/${slug}`, md).has(id)) errors.push(`${where}: no heading for /${area}/${slug}#${id}`)
    }

    const sources = [
      ...allPages().map((p) => ({ ...p, self: p.where.split('/') as [string, string] })),
      ...faqEntries.map((f) => ({ where: `faq:"${f.question.slice(0, 32)}"`, content: f.answer, self: undefined })),
      ...guideFaqs.map((f) => ({ where: `guideFaq:"${f.question.slice(0, 32)}"`, content: f.answer, self: undefined })),
    ]
    for (const { where, content, self } of sources) {
      for (const m of content.matchAll(/(?<=^|[("'\s>])\/(docs|guide)\/([a-z0-9-]+)#([^)\s"'<>]+)/g)) {
        check(where, m[1], m[2], m[3])
      }
      if (!self) continue
      for (const m of content.matchAll(/\]\(#([^)\s]+)\)/g)) check(where, self[0], self[1], m[1])
      if (self[0] !== 'docs') continue
      for (const m of content.matchAll(MD_LINK)) {
        const [, anchor] = m[1].split('#')
        const routed = rewriteDocLink(m[1])
        if (anchor && routed.startsWith('/docs/')) check(where, 'docs', routed.slice(6).split('#')[0], anchor)
      }
    }
    expect(errors).toEqual([])
  })

  it('tour buttons name a tour that can start from the docs', () => {
    // A ```tour-<id>``` fence deep-links into the app. A contextual tour's
    // targets exist only on its own page, so from the docs it would start blind.
    const errors: string[] = []
    for (const { where, content } of allPages()) {
      for (const m of content.matchAll(/```tour-([a-z0-9-]+)/g)) {
        const tour = getTour(m[1])
        if (!tour) errors.push(`${where}: unknown tour "${m[1]}"`)
        else if (tour.contextual) errors.push(`${where}: tour "${m[1]}" is contextual — point to Help on its page instead`)
      }
    }
    expect(errors).toEqual([])
  })

  it('every /docs-assets image exists', () => {
    const publicDir = join(__dirname, '..', '..', '..', 'public')
    const errors: string[] = []
    for (const { where, content } of allPages()) {
      for (const m of content.matchAll(/!\[[^\]]*\]\((\/docs-assets\/[^)\s]+)\)/g)) {
        if (!existsSync(join(publicDir, m[1]))) errors.push(`${where}: missing image ${m[1]}`)
      }
    }
    expect(errors).toEqual([])
  })

  it('pages carry no raw HTML (the reader shows it as literal text)', () => {
    const TAG = /<!--|<\/?(?:a|abbr|b|br|code|del|details|div|em|h[1-6]|hr|i|img|kbd|li|ol|p|pre|s|small|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/gi
    const errors: string[] = []
    for (const { where, content } of allPages()) {
      for (const m of proseOnly(content).matchAll(TAG)) errors.push(`${where}: ${m[0]}`)
    }
    expect(errors).toEqual([])
  })

  it('docs, guides and FAQ answers point at nothing on GitHub', () => {
    // A deployment serves these pages itself and may not reach GitHub. A
    // relative link works there and in the repository alike; register the
    // target instead of linking a GitHub-hosted copy.
    const GITHUB = /\b(?:github\.com|github\.io|githubusercontent\.com|ghcr\.io)\b/i
    const errors: string[] = []
    for (const { where, content } of allPages()) {
      if (GITHUB.test(content)) errors.push(where)
    }
    for (const f of [...faqEntries, ...guideFaqs]) {
      if (GITHUB.test(f.answer)) errors.push(`faq:"${f.question.slice(0, 32)}"`)
    }
    expect(errors).toEqual([])
  })
})
