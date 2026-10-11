import { useId, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useDocsSearchIndex } from '@/components/docs/search/useDocsSearchIndex'
import { useReader } from './ReaderContext'
import type { ReaderArea } from './paths'

/** A page the filter can list before the search index is ready. */
export interface FilterablePage {
  slug: string
  title: string
  description?: string
}

/** One link in the filtered list. */
export interface FilterLink {
  key: string
  href: string
  label: string
  kind: 'page' | 'section' | 'faq'
  detail?: string
}

/** A page and the sections of it that matched. */
export interface FilterGroup {
  page: FilterLink
  sections: FilterLink[]
}

export interface SidebarFilter {
  query: string
  setQuery: (q: string) => void
  /** True while there is something typed — the filtered list replaces the contents. */
  filtering: boolean
  groups: FilterGroup[]
  links: FilterLink[]
  activeIndex: number
  setActiveIndex: (i: number) => void
  listId: string
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  searchEverything: () => void
}

/**
 * "Filter pages" in a reader's sidebar: narrows the table of contents to the
 * pages — and the sections of pages — that mention what was typed, using the
 * same full-text index as Search everything, limited to this reader. Until
 * the index is ready it matches titles and descriptions, so the first
 * keystroke already answers. ↑/↓ move, Enter opens, Esc clears, and
 * Shift+Enter hands the query to Search everything.
 */
export function useSidebarFilter(area: ReaderArea, pages: FilterablePage[]): SidebarFilter {
  const brand = useBrand()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const reader = useReader()
  // A filter has done its job once the reader has gone somewhere, so it
  // belongs to the page it was typed on; the highlighted row, to the query.
  const [typed, setTyped] = useState({ query: '', on: pathname })
  const query = typed.on === pathname ? typed.query : ''
  const setQuery = (value: string) => setTyped({ query: value, on: pathname })
  const q = query.trim()
  const [active, setActive] = useState({ index: 0, for: '' })
  const setActiveIndex = (index: number) => setActive({ index, for: q })
  const listId = useId()
  const { ready, search } = useDocsSearchIndex(q.length > 0)

  const groups = useMemo<FilterGroup[]>(() => {
    if (!q) return []
    if (!ready) {
      const needle = q.toLowerCase()
      return pages
        .filter((p) =>
          `${interpolateBrand(p.title, brand)} ${p.description ? interpolateBrand(p.description, brand) : ''}`
            .toLowerCase()
            .includes(needle),
        )
        .map((p) => ({
          page: { key: p.slug, href: `/${area}/${p.slug}`, label: interpolateBrand(p.title, brand), kind: 'page' as const },
          sections: [],
        }))
    }
    const out: FilterGroup[] = []
    for (const hit of search(q, { only: area, limit: 30, perPage: 3 })) {
      const pageKey = hit.kind === 'faq' ? hit.href : `${hit.area}:${hit.slug}`
      const last = out[out.length - 1]
      if (last && last.page.key === pageKey) {
        if (hit.kind === 'section' && hit.heading) {
          last.sections.push({ key: hit.href, href: hit.href, label: hit.heading, kind: 'section' })
        }
        continue
      }
      if (hit.kind === 'faq') {
        out.push({ page: { key: pageKey, href: hit.href, label: hit.heading ?? hit.title, kind: 'faq', detail: 'FAQ' }, sections: [] })
      } else {
        out.push({
          page: { key: pageKey, href: `/${hit.area}/${hit.slug}`, label: hit.title, kind: 'page', detail: hit.sectionLabel },
          sections: hit.kind === 'section' && hit.heading
            ? [{ key: hit.href, href: hit.href, label: hit.heading, kind: 'section' }]
            : [],
        })
      }
    }
    return out
  }, [q, ready, search, area, pages, brand])

  const links = useMemo(() => groups.flatMap((g) => [g.page, ...g.sections]), [groups])
  // The list can change under the same query — titles first, then the full index.
  const activeIndex = Math.max(0, Math.min(active.for === q ? active.index : 0, links.length - 1))

  const searchEverything = () => reader?.openSearch(query)

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    } else if (e.key === 'Enter' && e.shiftKey && q) {
      e.preventDefault()
      searchEverything()
    } else if (e.key === 'Enter' && links[activeIndex]) {
      e.preventDefault()
      navigate(links[activeIndex].href)
    } else if (e.key === 'ArrowDown' && links.length) {
      e.preventDefault()
      setActiveIndex((activeIndex + 1) % links.length)
    } else if (e.key === 'ArrowUp' && links.length) {
      e.preventDefault()
      setActiveIndex((activeIndex - 1 + links.length) % links.length)
    }
  }

  return {
    query, setQuery, filtering: q.length > 0, groups, links, activeIndex, setActiveIndex, listId, onKeyDown, searchEverything,
  }
}
