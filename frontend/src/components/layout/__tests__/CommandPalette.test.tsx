/**
 * CommandPalette — the app-wide ⌘K palette.
 *
 * Two things are pinned here. First, the palette does no work while it is
 * closed: it is mounted for the whole session inside AppLayout, and the
 * version that kept its hooks in the always-mounted shell ran a global
 * search — and the dashboard fetches behind it — on every page of the
 * product. Second, the palette now answers for the product itself, so the
 * new categories have to arrive, be reachable, and say honest numbers:
 * "Show all 137 in Explorer" is a claim about the server's total, not
 * about the page of views we happened to fetch.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATEGORY_ORDER, type GlobalSearchResult } from '@/hooks/useGlobalSearch'

const { globalSearch, recentViews } = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  recentViews: vi.fn(),
}))

vi.mock('@/hooks/useGlobalSearch', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useGlobalSearch')>(
    '@/hooks/useGlobalSearch',
  )
  return { ...actual, useGlobalSearch: globalSearch }
})
vi.mock('@/hooks/useRecentViews', () => ({ useRecentViews: recentViews }))

import { CommandPalette } from '../CommandPalette'

const QUERY = 'lineage'
const PALETTE_KEY = 'nexus.palette.recentSearches'
const EXPLORER_KEY = 'nexus.explorer.recentSearches'
const CANVAS_HINT = 'Looking for data in this view? Press / on the canvas.'

/**
 * One hit per new category plus the two that changed behaviour. The API
 * objects are partial on purpose — the palette reads an id, a label and a
 * `catalogItemId`, and a full `View`/`WorkspaceResponse` here would say
 * nothing extra.
 */
function fixture(overrides: { catalogItemId?: string } = {}): GlobalSearchResult {
  return {
    query: QUERY,
    isLoading: false,
    byCategory: {
      Page: [{
        id: 'page-explorer', category: 'Page', score: 1,
        name: 'Data lineage explorer', description: 'Browse every view', path: '/explorer',
      }],
      View: [{
        id: 'view-v1', category: 'View', score: 1,
        name: 'Quarterly revenue', view: { id: 'v1', name: 'Quarterly revenue' },
      }],
      Workspace: [],
      'Data Source': [{
        id: 'ds-1', category: 'Data Source', score: 1, name: 'Snowflake warehouse',
        workspace: { id: 'ws-1', name: 'Finance' },
        dataSource: { id: 'ds-1', label: 'Snowflake warehouse', ...overrides },
      }],
      Template: [],
      'Semantic Layer': [],
      Setting: [{
        id: 'page-account', category: 'Setting', score: 1,
        name: 'Account settings', path: '/me/account',
      }],
      Doc: [{
        id: 'doc-guide-reading', category: 'Doc', score: 1,
        name: 'Reading a lineage graph', area: 'guide', slug: 'reading-a-lineage-graph',
      }],
    },
    totalByCategory: {
      Page: 1, View: 137, Workspace: 0, 'Data Source': 1,
      Template: 0, 'Semantic Layer': 0, Setting: 1, Doc: 1,
    },
    viewsHasMore: true,
  } as unknown as GlobalSearchResult
}

/** The same shape with every category empty — a query nothing answered. */
function emptyFixture(): GlobalSearchResult {
  const base = fixture()
  for (const category of CATEGORY_ORDER) {
    base.byCategory[category] = []
    base.totalByCategory[category] = 0
  }
  return { ...base, viewsHasMore: false }
}

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <div data-testid="location">{`${pathname}${search}`}</div>
}

function renderPalette(open: boolean, route = '/dashboard') {
  const onOpenChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <input aria-label="page field" />
        <CommandPalette open={open} onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

/** Type a query so the palette leaves its zero-search state. */
function type(query = QUERY) {
  fireEvent.change(screen.getByPlaceholderText(/^Search pages/), { target: { value: query } })
}

/**
 * Rows are matched on their whole text: the name is split into elements by
 * the query highlighting, so `getByText` on the name alone would miss.
 */
function clickRow(text: string) {
  const rows = Array.from(document.querySelectorAll('[cmdk-item]')) as HTMLElement[]
  const row = rows.find(r => r.textContent?.includes(text))
  if (!row) throw new Error(`No palette row containing "${text}"`)
  fireEvent.click(row)
}

const locationNow = () => screen.getByTestId('location').textContent

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  globalSearch.mockReturnValue(fixture({ catalogItemId: 'cat-9' }))
  recentViews.mockReturnValue({ recent: [], recordVisit: vi.fn() })
})

describe('CommandPalette — closed', () => {
  it('runs no search and fetches no recents while closed', () => {
    renderPalette(false)
    expect(globalSearch).not.toHaveBeenCalled()
    expect(recentViews).not.toHaveBeenCalled()
  })

  it('opens on ⌘K', () => {
    const { onOpenChange } = renderPalette(false)
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true })
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('leaves ⌘K alone while the reader is typing in a field', () => {
    const { onOpenChange } = renderPalette(false)
    fireEvent.keyDown(screen.getByLabelText('page field'), { key: 'k', metaKey: true })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('CommandPalette — open', () => {
  it('searches app-wide', () => {
    renderPalette(true)
    expect(globalSearch).toHaveBeenCalledWith(expect.any(String), { appWide: true })
  })

  it('groups pages, settings and docs under their own headings', () => {
    renderPalette(true)
    type()
    expect(screen.getByText('Pages')).toBeInTheDocument()
    expect(screen.getByText('Settings & Admin')).toBeInTheDocument()
    expect(screen.getByText('Docs & Guides')).toBeInTheDocument()
  })

  it('offers every matching view in Explorer, counted by the server', () => {
    renderPalette(true)
    type()
    expect(screen.getByText(/Show all 137 in Explorer/)).toBeInTheDocument()
    clickRow('Show all 137 in Explorer')
    expect(locationNow()).toBe('/explorer?q=lineage')
  })

  it('points at the canvas search from a view', () => {
    renderPalette(true, '/views/v1')
    expect(screen.getByText(CANVAS_HINT)).toBeInTheDocument()
  })

  it('keeps the canvas hint off pages without a canvas', () => {
    renderPalette(true, '/dashboard')
    expect(screen.queryByText(CANVAS_HINT)).not.toBeInTheDocument()
  })

  it('names every category it searched when nothing matched', () => {
    globalSearch.mockReturnValue(emptyFixture())
    renderPalette(true)
    type()
    expect(screen.getByText(
      'No matching pages, views, workspaces, data sources, or docs.'
      + ' Try a different keyword, or use a command below.',
    )).toBeInTheDocument()
  })

  it('closes on ⌘K from its own input', () => {
    const { onOpenChange } = renderPalette(true)
    fireEvent.keyDown(screen.getByPlaceholderText(/^Search pages/), { key: 'k', metaKey: true })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('CommandPalette — where a hit takes you', () => {
  it('opens a page at its path', () => {
    renderPalette(true)
    type()
    clickRow('Data lineage explorer')
    expect(locationNow()).toBe('/explorer')
  })

  it('opens a setting at its path', () => {
    renderPalette(true)
    type()
    clickRow('Account settings')
    expect(locationNow()).toBe('/me/account')
  })

  it('opens a doc in its own area', () => {
    renderPalette(true)
    type()
    clickRow('Reading a lineage graph')
    expect(locationNow()).toBe('/guide/reading-a-lineage-graph')
  })

  it('opens a catalogued data source on its own page', () => {
    renderPalette(true)
    type()
    clickRow('Snowflake warehouse')
    expect(locationNow()).toBe('/datasources/cat-9')
  })

  it('falls back to the workspace for a data source with no catalogue entry', () => {
    globalSearch.mockReturnValue(fixture())
    renderPalette(true)
    type()
    clickRow('Snowflake warehouse')
    expect(locationNow()).toBe('/workspaces/ws-1')
  })

  it('sends Open Settings to the account page', () => {
    renderPalette(true)
    clickRow('Open Settings')
    expect(locationNow()).toBe('/me/account')
  })
})

describe('CommandPalette — recent searches', () => {
  it('remembers its own queries, leaving the Explorer box alone', () => {
    renderPalette(true)
    type()
    clickRow('Data lineage explorer')
    expect(window.localStorage.getItem(PALETTE_KEY)).toContain(QUERY)
    expect(window.localStorage.getItem(EXPLORER_KEY)).toBeNull()
  })
})
