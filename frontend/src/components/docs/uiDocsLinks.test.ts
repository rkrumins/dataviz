import { describe, expect, it } from 'vitest'

import { guideEntries } from '@/components/guide/guideConfig'
import { DEFAULT_BRANDING } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { docEntries } from './docsConfig'
import { headingIds } from './reading/headings'

/**
 * Every link the app itself shows into the guide or the docs opens a page.
 *
 * Help icons, "Learn more" links and wizard help buttons name a slug in code.
 * The reader's link checks only see links written in markdown, so a renamed
 * or retired page turned these into "page not found" without failing anything
 * — Administration → Features linked `/docs/features`, which never existed.
 * This reads every source file and checks each slug and anchor it names.
 */

const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

type Area = 'guide' | 'docs'
interface Ref { area: Area; slug: string; anchor?: string; where: string }

const quoted = (s: string) => [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])

function collect(): Ref[] {
  const refs: Ref[] = []
  for (const [file, src] of Object.entries(sources)) {
    // <DocsLink slug="…" area="docs" …/> — guide unless area says otherwise.
    for (const m of src.matchAll(/<DocsLink\b([^>]*?)\/?>/gs)) {
      const slug = /\bslug="([^"]+)"/.exec(m[1])?.[1]
      if (!slug) continue // slug={variable}: covered where the value is written
      const area: Area = /\barea="docs"/.test(m[1]) ? 'docs' : 'guide'
      refs.push({ area, slug, where: file })
    }
    // helpSlug / guideSlug props and config keys name guide pages.
    for (const m of src.matchAll(/\b(?:helpSlug|guideSlug)\??\s*[=:]\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
      for (const slug of quoted(m[1])) refs.push({ area: 'guide', slug, where: file })
    }
    // Literal routes: '/guide/x', "/docs/x#anchor", `/docs/x`.
    for (const m of src.matchAll(/["'`]\/(guide|docs)\/([a-z0-9-]+)(?:#([a-z0-9-]+))?["'`?]/g)) {
      refs.push({ area: m[1] as Area, slug: m[2], anchor: m[3], where: file })
    }
  }
  return refs
}

const pages: Record<Area, Map<string, () => Promise<{ default: string }>>> = {
  guide: new Map(guideEntries.map((e) => [e.slug, e.importFn])),
  docs: new Map(docEntries.map((e) => [e.slug, e.importFn])),
}
// Routes that are pages without being entries.
const ROUTES: Record<Area, Set<string>> = { guide: new Set(), docs: new Set(['faq']) }

describe('links into the guide and docs from the app', () => {
  const refs = collect()

  it('finds the links (the scan itself works)', () => {
    expect(refs.length).toBeGreaterThan(20)
  })

  it('every slug names a registered page', () => {
    const dead = refs
      .filter((r) => !pages[r.area].has(r.slug) && !ROUTES[r.area].has(r.slug))
      .map((r) => `${r.where}: /${r.area}/${r.slug}`)
    expect(dead).toEqual([])
  })

  it('every anchor names a heading on that page', async () => {
    const broken: string[] = []
    for (const r of refs.filter((x) => x.anchor && pages[x.area].has(x.slug))) {
      const md = interpolateBrand((await pages[r.area].get(r.slug)!()).default, DEFAULT_BRANDING)
      if (!headingIds(md).has(r.anchor!)) broken.push(`${r.where}: /${r.area}/${r.slug}#${r.anchor}`)
    }
    expect(broken).toEqual([])
  })
})
