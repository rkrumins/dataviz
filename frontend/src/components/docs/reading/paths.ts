/**
 * Reading paths — the pages each persona reads, in order.
 *
 * The docs and the guide each list theirs on their personas (`path`); this
 * module gives both one shape so the reader can say "Step 2 of 6", offer the
 * next page and show how far along a path someone is.
 */
import type { LucideIcon } from 'lucide-react'
import { docPersonas, getEntryBySlug } from '@/components/docs/docsConfig'
import { guidePersonas, getGuideEntry } from '@/components/guide/guideConfig'

export type ReaderArea = 'docs' | 'guide'

export interface ReadingPath {
  area: ReaderArea
  /** The persona's id. */
  id: string
  label: string
  icon: LucideIcon
  accent: { gradient: string; text: string; soft: string; border: string; glow: string }
  slugs: string[]
}

export const READING_PATHS: ReadingPath[] = [
  ...docPersonas.map((p): ReadingPath => ({
    area: 'docs', id: p.id, label: p.label, icon: p.icon, accent: p.accent, slugs: p.path,
  })),
  ...guidePersonas.map((p): ReadingPath => ({
    area: 'guide', id: p.id, label: p.label, icon: p.icon, accent: p.accent, slugs: p.path,
  })),
]

/** The key a page is remembered under in the reading store. */
export function readKey(area: ReaderArea, slug: string): string {
  return `${area}:${slug}`
}

export function getPath(area: ReaderArea, id: string | undefined): ReadingPath | undefined {
  return id ? READING_PATHS.find((p) => p.area === area && p.id === id) : undefined
}

/** The paths that include `slug`; the one that starts with it first. */
export function pathsContaining(area: ReaderArea, slug: string): ReadingPath[] {
  return READING_PATHS
    .filter((p) => p.area === area && p.slugs.includes(slug))
    .sort((a, b) => a.slugs.indexOf(slug) - b.slugs.indexOf(slug))
}

/** A page's title and description, `{brand}` tokens and all. */
export function pageInfo(area: ReaderArea, slug: string): { title: string; description?: string } | undefined {
  const entry = area === 'docs' ? getEntryBySlug(slug) : getGuideEntry(slug)
  return entry ? { title: entry.title, description: entry.description } : undefined
}

/** The first step of `path` not yet read, or `undefined` when every step is. */
export function nextUnread(path: ReadingPath, read: Record<string, number>): string | undefined {
  return path.slugs.find((slug) => !read[readKey(path.area, slug)])
}

export function readCount(path: ReadingPath, read: Record<string, number>): number {
  return path.slugs.filter((slug) => read[readKey(path.area, slug)]).length
}

/** The call to action on a persona's hub card, by how far along its path the reader is. */
export function personaCta(path: ReadingPath, read: Record<string, number>): { href: string; label: string; done: number } {
  const done = readCount(path, read)
  const next = nextUnread(path, read)
  if (done === 0) return { href: `/${path.area}/${path.slugs[0]}`, label: 'Start here', done }
  if (next) return { href: `/${path.area}/${next}`, label: `Continue · ${done} of ${path.slugs.length} read`, done }
  return { href: `/${path.area}/${path.slugs[0]}`, label: 'Completed — read again', done }
}
