/**
 * The docs search, run against the real docs and guide.
 *
 * Every query here failed the reader before: the best page ranked below the
 * fold because every docs hit was listed before every guide hit, words were
 * matched inside other words, a typo found nothing, and a hit opened the top
 * of a page whose answer sat a screen or more further down.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_BRANDING } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { docEntries } from '@/components/docs/docsConfig'
import { guideEntries } from '@/components/guide/guideConfig'
import { headingIds } from '@/components/docs/reading/headings'
import { getIndex, runSearch, plainText, type DocsSearchIndex } from './useDocsSearchIndex'
import { processTerm, stem } from './terms'

let index: DocsSearchIndex

beforeAll(async () => {
  index = await getIndex(DEFAULT_BRANDING)
}, 60_000)

const top = (q: string, area?: 'docs' | 'guide') => runSearch(index, q, { area })[0]

describe('terms', () => {
  it.each([
    ['tracing', 'trace'], ['traces', 'trace'], ['traced', 'trace'],
    ['requesting', 'request'], ['passwords', 'password'], ['policies', 'polici'],
    ['policy', 'polici'], ['creating', 'create'], ['viewing', 'view'], ['keys', 'kei'], ['key', 'kei'],
    ['access', 'access'], ['status', 'status'], ['analysis', 'analysis'],
  ])('%s → %s', (word, expected) => {
    expect(stem(word)).toBe(expected)
  })

  it('drops filler words and single letters', () => {
    expect(processTerm('the')).toBeNull()
    expect(processTerm('a')).toBeNull()
    expect(processTerm('Provider')).toBe('provider')
  })

  it('keeps identifiers whole and drops emphasis', () => {
    expect(plainText('Set **`ADMIN_PASSWORD`** _first_, see [Setup](/docs/setup).'))
      .toBe('Set ADMIN_PASSWORD first, see Setup.')
  })
})

describe('ranking', () => {
  it('puts the best page first, whichever area it is in', () => {
    expect(top('review', 'guide').slug).toBe('review-center')
    expect(top('request access').slug).toBe('requesting-access')
    expect(top('trace lineage', 'guide').slug).toBe('exploring-graph')
  })

  it('finds a page by the name people search for it by', () => {
    const sso = runSearch(index, 'sso', { area: 'guide', limit: 2 }).map((r) => r.slug)
    expect(sso.some((s) => s.startsWith('sso-'))).toBe(true)
    expect(top('k8s', 'docs').slug).toBe('kubernetes')
  })

  it('prefers the area being read when both have a good page', () => {
    expect(top('single sign-on', 'guide').area).toBe('guide')
    expect(top('single sign-on', 'docs').area).toBe('docs')
  })

  it('matches whole words, not fragments of other words', () => {
    const hit = top('review', 'guide')
    const words = hit.snippet.filter((s) => s.hit).map((s) => s.text.toLowerCase())
    expect(words.every((w) => w.startsWith('review'))).toBe(true)
  })

  it('forgives typos and spelling variants', () => {
    expect(top('kuberntes', 'docs').slug).toBe('kubernetes')
    expect(runSearch(index, 'passwrod').length).toBeGreaterThan(0)
    const favourite = runSearch(index, 'favourite', { area: 'guide', limit: 3 }).map((r) => r.slug)
    const favorite = runSearch(index, 'favorite', { area: 'guide', limit: 3 }).map((r) => r.slug)
    expect(favourite).toContain('browsing-views')
    expect(favorite).toContain('browsing-views')
  })

  it('ignores filler words in a question', () => {
    const hits = runSearch(index, 'what is a provider', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => /provider/i.test(`${h.title} ${h.heading ?? ''}`))).toBe(true)
  })
})

describe('landing', () => {
  it('links a section hit to its heading', () => {
    expect(top('load demo data', 'docs').href).toBe('/docs/setup#load-demo-data')
    const sso = top('map their fields to ours', 'guide')
    expect(sso.slug).toBe('sso-setup')
    expect(sso.href).toMatch(/^\/guide\/sso-setup#/)
  })

  it('finds FAQ answers and links to the question', () => {
    const hits = runSearch(index, 'No data source for workspace', { limit: 3 })
    const faq = hits.find((h) => h.kind === 'faq')
    expect(faq?.href).toMatch(/^\/docs\/faq#faq-/)
  })

  it('links only to anchors the rendered page has', () => {
    const ids = new Map<string, Set<string>>()
    const load = async (area: string, entries: { slug: string; importFn: () => Promise<{ default: string }> }[]) => {
      for (const e of entries) {
        const md = interpolateBrand((await e.importFn()).default, DEFAULT_BRANDING)
        ids.set(`${area}:${e.slug}`, headingIds(md))
      }
    }
    return Promise.all([load('docs', docEntries), load('guide', guideEntries)]).then(() => {
      for (const entry of index.entries.values()) {
        if (entry.kind !== 'section') continue
        expect(ids.get(`${entry.area}:${entry.slug}`)?.has(entry.anchor), entry.href).toBe(true)
      }
    })
  })
})

describe('what readers see', () => {
  it('never shows a raw brand token', () => {
    for (const q of ['brand', 'welcome', 'sign in', 'kubernetes']) {
      for (const hit of runSearch(index, q, { limit: 20, perPage: 3 })) {
        // Contributing shows the token on purpose — it explains how to use it,
        // and the reader renders it literally there too.
        if (hit.slug === 'contributing') continue
        const shown = `${hit.title} ${hit.heading ?? ''} ${hit.snippet.map((s) => s.text).join('')}`
        expect(shown, q).not.toMatch(/\{brand(Short)?\}/)
      }
    }
  })

  it('finds the displayed title of the welcome page', () => {
    const title = interpolateBrand('Welcome to {brand}', DEFAULT_BRANDING)
    expect(top(title, 'guide').slug).toBe('welcome')
  })

  it('searches inside code blocks', () => {
    expect(runSearch(index, 'kubectl', { limit: 50 }).length).toBeGreaterThanOrEqual(12)
  })
})
