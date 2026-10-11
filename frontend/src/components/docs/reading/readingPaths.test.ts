/**
 * The reading paths the reader offers ("Step 2 of 6", "Next in your path")
 * are the ones the pages themselves give: each docs persona's start page
 * lists its path under "Your path", and the guide's Welcome page lists each
 * persona's under "Who is this guide for?". One list, so following a path
 * never contradicts the page you are reading.
 */
import { describe, expect, it } from 'vitest'
import { docPersonas, getEntryBySlug } from '@/components/docs/docsConfig'
import { guidePersonas, getGuideEntry } from '@/components/guide/guideConfig'
import { READING_PATHS, getPath, nextUnread, pathsContaining, personaCta, readCount, readKey } from './paths'

/** The slugs linked from the numbered list items of `section` (a chunk of markdown), in order. */
function listedSlugs(section: string, area: 'docs' | 'guide'): string[] {
  const items: string[] = []
  let current: string | null = null
  for (const line of section.split('\n')) {
    if (/^\s{0,3}\d+\.\s/.test(line)) {
      if (current !== null) items.push(current)
      current = line
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`
    } else if (current !== null) {
      items.push(current)
      current = null
    }
  }
  if (current !== null) items.push(current)
  const slugs: string[] = []
  const link = new RegExp(`\\]\\(/${area}/([a-z0-9-]+)`, 'g')
  for (const item of items) {
    for (const m of item.matchAll(link)) if (!slugs.includes(m[1])) slugs.push(m[1])
  }
  return slugs
}

/** The markdown from `heading` (a line) to the next heading at the same depth or above. */
function sectionAfter(md: string, heading: RegExp): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  if (start === -1) return ''
  const depth = /^#+/.exec(lines[start])![0].length
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= depth)
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

describe('reading paths', () => {
  it('start where the persona card says, with pages that exist, once each', () => {
    for (const p of docPersonas) {
      expect(p.path[0], p.id).toBe(p.startSlug)
      expect(new Set(p.path).size, p.id).toBe(p.path.length)
      for (const slug of p.path) expect(getEntryBySlug(slug), `${p.id}: ${slug}`).toBeDefined()
    }
    for (const p of guidePersonas) {
      expect(p.path[0], p.id).toBe(p.startSlug)
      expect(new Set(p.path).size, p.id).toBe(p.path.length)
      for (const slug of p.path) expect(getGuideEntry(slug), `${p.id}: ${slug}`).toBeDefined()
    }
  })

  it.each(docPersonas.map((p) => [p.label, p] as const))(
    'docs: %s follows the "Your path" list on its start page',
    async (_label, persona) => {
      const md = (await getEntryBySlug(persona.startSlug)!.importFn()).default
      const listed = listedSlugs(sectionAfter(md, /^## Your path\s*$/), 'docs')
      expect(listed.length, persona.startSlug).toBeGreaterThan(0)
      expect(persona.path.slice(1)).toEqual(listed.filter((s) => s !== persona.startSlug))
    },
  )

  it.each(guidePersonas.map((p) => [p.label, p] as const))(
    'guide: %s follows its list on the Welcome page',
    async (label, persona) => {
      const md = (await getGuideEntry('welcome')!.importFn()).default
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const listed = listedSlugs(sectionAfter(md, new RegExp(`^### ${escaped}( —|$)`)), 'guide')
      expect(listed.length, label).toBeGreaterThan(0)
      expect(persona.path).toEqual(listed)
    },
  )
})

describe('progress along a path', () => {
  const path = getPath('docs', 'new-engineer')!

  it('counts the pages read and names the next one', () => {
    const read = { [readKey('docs', path.slugs[0])]: 1, [readKey('docs', path.slugs[2])]: 2 }
    expect(readCount(path, read)).toBe(2)
    expect(nextUnread(path, read)).toBe(path.slugs[1])
    expect(nextUnread(path, Object.fromEntries(path.slugs.map((s) => [readKey('docs', s), 1])))).toBeUndefined()
  })

  it('reads a page of the other area as unread', () => {
    expect(readCount(path, { [readKey('guide', path.slugs[0])]: 1 })).toBe(0)
  })

  it('tells a persona card where to send the reader', () => {
    expect(personaCta(path, {})).toMatchObject({ href: `/docs/${path.slugs[0]}`, label: 'Start here' })
    const one = { [readKey('docs', path.slugs[0])]: 1 }
    expect(personaCta(path, one)).toMatchObject({ href: `/docs/${path.slugs[1]}`, label: `Continue · 1 of ${path.slugs.length} read` })
    const all = Object.fromEntries(path.slugs.map((s) => [readKey('docs', s), 1]))
    expect(personaCta(path, all)).toMatchObject({ href: `/docs/${path.slugs[0]}`, label: 'Completed — read again' })
  })

  it('offers the path a page starts before one it merely appears in', () => {
    const containing = pathsContaining('docs', 'security-overview').map((p) => p.id)
    expect(containing[0]).toBe('security')
    expect(containing).toContain('architect')
  })

  it('covers every persona of both readers', () => {
    expect(READING_PATHS.filter((p) => p.area === 'docs')).toHaveLength(docPersonas.length)
    expect(READING_PATHS.filter((p) => p.area === 'guide')).toHaveLength(guidePersonas.length)
  })
})
