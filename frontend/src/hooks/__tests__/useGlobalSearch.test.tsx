/**
 * The app-wide lane of the global search.
 *
 * `useGlobalSearch` serves two callers with different appetites. The
 * Dashboard hero searches CONTENT — the things a person made. The ⌘K
 * palette also searches the PRODUCT — the pages, the settings, the docs.
 * `appWide` is the switch, and these tests pin what turns on with it:
 *
 *   * nothing, by default — and in particular the docs index, whose
 *     build fetches every markdown chunk, must not be touched by a
 *     dashboard keystroke, nor read back out of the shared cache once
 *     the palette has built it;
 *   * only the destinations this reader may actually open, resolved
 *     through the same gates the routes use;
 *   * deep tabs as first-class destinations, `?tab=` and all, and the
 *     words people use for a screen that has since been folded into
 *     another one;
 *   * the server's own count for views, not the length of the page we
 *     happened to fetch;
 *   * docs copy with the brand tokens resolved, because `{brand}` is
 *     what the markdown literally says.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useDashboardData', () => ({
    useDashboardData: () => ({ workspaces: [], templates: [], ontologies: [] }),
}))

vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn() }))

vi.mock('@/components/docs/search/useDocsSearchIndex', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/docs/search/useDocsSearchIndex')>()),
    getIndex: vi.fn(),
}))

import { getIndex, type IndexEntry } from '@/components/docs/search/useDocsSearchIndex'
import { listViews, type View } from '@/services/viewApiService'
import { DEFAULT_BRANDING } from '@/store/branding'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

import { useGlobalSearch, type DocHit, type PageHit } from '../useGlobalSearch'

const listViewsMock = vi.mocked(listViews)
const getIndexMock = vi.mocked(getIndex)

/** One doc, carrying the `{brand}` tokens the real markdown carries. */
const DOCS_INDEX: IndexEntry[] = [
    {
        area: 'guide',
        slug: 'getting-started',
        title: 'Getting started with {brand}',
        titleLower: 'getting started with {brand}',
        sectionLabel: 'User Guide',
        headingsLower: 'first steps',
        body: '{brand} draws lineage from every source you connect.',
        bodyLower: '{brand} draws lineage from every source you connect.',
    },
]

const ORDERS_VIEW = {
    id: 'v1',
    name: 'Orders lineage',
    description: 'Where an order comes from',
    workspaceId: 'w1',
    workspaceName: 'Sales',
    viewType: 'graph',
    config: {},
    visibility: 'private',
} as unknown as View

const EMPTY_VIEWS = { items: [], total: 0, hasMore: false, nextOffset: null }

/** One client per test, shared by every hook in it — as in the real app. */
let queryClient: QueryClient

function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function claims(global: string[] = [], ws: Record<string, string[]> = {}) {
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        permissions: { sid: 's1', global, ws },
        permissionsStatus: 'ready',
    })
}

const paths = (hits: { path?: string }[]) => hits.map((h) => h.path)

beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    listViewsMock.mockResolvedValue(EMPTY_VIEWS)
    getIndexMock.mockResolvedValue(DOCS_INDEX)
    claims()
    useFeaturesStore.setState({
        values: { ...DEFAULT_FEATURES, analyticsPublicEnabled: false },
        loaded: true,
    })
})

describe('useGlobalSearch', () => {
    it('leaves pages, settings and docs alone unless asked for them', async () => {
        const { result } = renderHook(() => useGlobalSearch('account'), { wrapper })

        await waitFor(() => expect(result.current.query).toBe('account'))

        expect(result.current.byCategory.Page).toEqual([])
        expect(result.current.byCategory.Setting).toEqual([])
        expect(result.current.byCategory.Doc).toEqual([])
        // Building the docs index fetches every markdown chunk. A dashboard
        // keystroke must never pay for that.
        expect(getIndexMock).not.toHaveBeenCalled()
    })

    it('keeps a cached docs index out of a content-only search', async () => {
        // One QueryClient serves the whole app, so the index the palette
        // built is still sitting in the cache when the Dashboard hero runs
        // its next search. `enabled: false` does not hide cached data.
        const palette = renderHook(() => useGlobalSearch('lineage', { appWide: true }), { wrapper })
        await waitFor(() => expect(palette.result.current.byCategory.Doc).toHaveLength(1))
        palette.unmount()

        const hero = renderHook(() => useGlobalSearch('lineage'), { wrapper })

        await waitFor(() => expect(hero.result.current.query).toBe('lineage'))
        expect(hero.result.current.byCategory.Doc).toEqual([])
    })

    it('offers the audit log only to a reader who clears both admin gates', async () => {
        const denied = renderHook(() => useGlobalSearch('audit', { appWide: true }), { wrapper })
        await waitFor(() => expect(denied.result.current.query).toBe('audit'))
        expect(paths(denied.result.current.byCategory.Setting as PageHit[])).not.toContain('/admin/audit')
        denied.unmount()

        claims(['system:groups:manage', 'system:audit:read'])
        const allowed = renderHook(() => useGlobalSearch('audit', { appWide: true }), { wrapper })
        await waitFor(() =>
            expect(paths(allowed.result.current.byCategory.Setting as PageHit[])).toContain('/admin/audit'),
        )
    })

    it('finds a deep tab and keeps its ?tab= link', async () => {
        claims([], { w1: ['workspace:provider:read'] })

        const { result } = renderHook(() => useGlobalSearch('freshness', { appWide: true }), { wrapper })

        await waitFor(() => expect(result.current.byCategory.Page).toHaveLength(1))
        expect((result.current.byCategory.Page[0] as PageHit).path).toBe('/ingestion?tab=freshness')
    })

    it('finds Explorer by what the retired gallery was called', async () => {
        // `/views` left the index — it only redirects here — and its words
        // would have left with it, so "gallery" found nothing at all.
        const { result } = renderHook(() => useGlobalSearch('gallery', { appWide: true }), { wrapper })

        await waitFor(() => expect(result.current.byCategory.Page).toHaveLength(1))
        expect((result.current.byCategory.Page[0] as PageHit).path).toBe('/explorer')
    })

    it('reports the server total for views, not the page it fetched', async () => {
        listViewsMock.mockResolvedValue({
            items: [ORDERS_VIEW],
            total: 137,
            hasMore: true,
            nextOffset: 50,
        })

        const { result } = renderHook(() => useGlobalSearch('orders'), { wrapper })

        await waitFor(() => expect(result.current.byCategory.View).toHaveLength(1))
        expect(result.current.totalByCategory.View).toBe(137)
        expect(result.current.viewsHasMore).toBe(true)
    })

    it('resolves the brand tokens in a doc title and snippet', async () => {
        const { result } = renderHook(() => useGlobalSearch('lineage', { appWide: true }), { wrapper })

        await waitFor(() => expect(result.current.byCategory.Doc).toHaveLength(1))

        const hit = result.current.byCategory.Doc[0] as DocHit
        expect(hit.name).toBe(`Getting started with ${DEFAULT_BRANDING.appName}`)
        expect(hit.description).toContain(DEFAULT_BRANDING.appName)
        expect(hit.description).not.toContain('{brand}')
        expect(hit.area).toBe('guide')
        expect(hit.slug).toBe('getting-started')
    })
})
