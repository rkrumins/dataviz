/**
 * The Explorer says what a view is made from — a query ("Auto-updating", "Snapshot") or a search
 * inside another view ("Subset") — on its card and in its preview.
 *
 *   - A card says it from the view's config, which the list carries: it asks the server for
 *     nothing, so it carries no count.
 *   - The preview reads how its one view stands: a view made from a query says how many members
 *     it holds, and each of its layers how many are placed there, instead of "No types assigned";
 *     a subset names the view it is a subset of, and its other-matches layer says what it holds.
 *   - With the feature off, the preview says what the config says, and asks nothing.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const membershipMock = vi.fn()
const searchMock = vi.fn()

vi.mock('@/services/liveViewsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/liveViewsApi')>()),
  getMembershipStatus: (...a: unknown[]) => membershipMock(...a),
}))
vi.mock('@/services/searchViewsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/searchViewsApi')>()),
  getSearchStatus: (...a: unknown[]) => searchMock(...a),
}))
vi.mock('@/hooks/useContentInsights', () => ({ useViewUsage: () => ({ data: undefined }) }))
vi.mock('@/components/views/ViewBuiltOn', () => ({ ViewBuiltOn: () => null }))
vi.mock('@/components/views/EditDetailsPanel', () => ({ EditDetailsPanel: () => null }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import type { View } from '@/services/viewApiService'
import type { MembershipStatus } from '@/types/membership'
import { ExplorerViewCard } from '../ExplorerViewCard'
import { ExplorerPreviewDrawer } from '../ExplorerPreviewDrawer'

const LAYERS = [
  { id: 'sources', name: 'Sources', color: '#3b82f6', entityTypes: [], order: 0 },
  { id: 'marts', name: 'Marts', color: '#10b981', entityTypes: [], order: 1 },
]

function view(config: Record<string, unknown> = {}): View {
  return {
    id: 'v1', name: 'Payments', viewType: 'reference', workspaceId: 'ws-1', workspaceName: 'Writes',
    dataSourceId: 'ds-1', visibility: 'private', tags: [], isPinned: false, favouriteCount: 0, isFavourited: false,
    createdAt: '2026-07-13T12:26:00Z', updatedAt: '2026-07-13T12:26:00Z',
    config: { layout: { type: 'reference', referenceLayout: { layers: LAYERS, assignments: {} } }, ...config },
  } as View
}

const membership = (mode: 'live' | 'snapshot') => ({
  membership: { v: 1, mode, sources: [], layout: { kind: 'auto' }, exclude: [], overrides: {}, provenance: { origin: 'narrow' } },
})
const SEARCH = { search: { v: 1, predicate: {}, within: 'view', readIn: 'v_base', layout: 'own', provenance: { origin: 'search' } } }

function status(over: Partial<MembershipStatus> = {}): MembershipStatus {
  return {
    mode: 'live', status: 'ok', revision: 3, definition: {} as MembershipStatus['definition'], definitionHash: 'h',
    counts: { members: 1234, perLayer: { sources: 800, marts: 434 } }, keys: 1300, limit: 50_000,
    truncated: [], readIn: [], alwaysIncluded: [], excluded: [], ...over,
  }
}

function renderCard(v: View) {
  return render(
    <MemoryRouter>
      <ExplorerViewCard view={v} onToggleFavourite={() => {}} onShare={() => {}} />
    </MemoryRouter>,
  )
}

function renderDrawer(v: View) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExplorerPreviewDrawer view={v} isOpen onClose={() => {}} onShare={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function features(values: Record<string, boolean>) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, ...values } })
}

beforeEach(() => {
  vi.clearAllMocks()
  features({ viewMembershipEnabled: true, searchViewsEnabled: true })
})

describe('Explorer card — what a view is made from', () => {
  it('marks a view made from a query, kept up to date or as a snapshot, and a subset — asking for nothing', () => {
    const { unmount } = renderCard(view(membership('live')))
    expect(screen.getByText('Auto-updating')).toBeInTheDocument()
    unmount()
    renderCard(view(membership('snapshot')))
    expect(screen.getByText('Snapshot')).toBeInTheDocument()
    renderCard(view(SEARCH))
    expect(screen.getByText('Subset')).toBeInTheDocument()
    expect(membershipMock).not.toHaveBeenCalled()
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('marks nothing on any other view', () => {
    const { container } = renderCard(view())
    expect(container.querySelector('[data-made-from]')).toBeNull()
  })
})

describe('Explorer preview — what a view is made from, as it stands', () => {
  it('says how many members a view made from a query holds, and how many each layer does', async () => {
    membershipMock.mockResolvedValue(status())
    renderDrawer(view(membership('live')))

    expect(await screen.findByText('Auto-updating · 1,234 members')).toBeInTheDocument()
    expect(screen.getByText('800 members')).toBeInTheDocument()
    expect(screen.getByText('434 members')).toBeInTheDocument()
    expect(screen.queryByText('No types assigned')).not.toBeInTheDocument()
    expect(membershipMock).toHaveBeenCalledWith('v1')
  })

  it('leads with the view a snapshot follows, and says when its members are still being worked out', async () => {
    membershipMock.mockResolvedValue(status({
      mode: 'snapshot', status: 'updating', counts: null, keys: 0,
      follows: { viewId: 'v_base', name: 'Finance', available: true },
    }))
    renderDrawer(view(membership('snapshot')))
    expect(await screen.findByText('Subset of Finance · Snapshot · working out its members')).toBeInTheDocument()
    expect(screen.getAllByText('Placed by its query')).toHaveLength(2)
  })

  it('names the view a subset is made from, and what its other-matches layer holds', async () => {
    searchMock.mockResolvedValue({
      definition: SEARCH.search, definitionHash: 'h', status: 'ok',
      base: { viewId: 'v_base', name: 'Finance', available: true }, layers: [], placedByType: false,
    })
    renderDrawer(view({
      ...SEARCH,
      layout: { type: 'reference', referenceLayout: { layers: [
        { id: 'tables', name: 'Tables', entityTypes: ['dataset'], order: 0 },
        { id: 'other-matches', name: 'Other matches', entityTypes: [], order: 1 },
      ], assignments: {} } },
    }))
    expect(await screen.findByText('Subset of Finance')).toBeInTheDocument()
    expect(screen.getByText('Every other match')).toBeInTheDocument()
    expect(membershipMock).not.toHaveBeenCalled()
  })

  it('says what the config says with the feature off, asking nothing', async () => {
    features({ viewMembershipEnabled: false, searchViewsEnabled: false })
    renderDrawer(view(membership('live')))
    expect(screen.getByText('Auto-updating')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Placed by its query')).toHaveLength(2))
    expect(membershipMock).not.toHaveBeenCalled()
  })
})
