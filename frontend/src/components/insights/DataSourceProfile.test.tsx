import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/hooks/useDataSourceProfile', () => ({
  useDataSourceProfile: () => ({
    item: { id: 'cat-1', providerId: 'p-1', sourceIdentifier: 'orders', name: 'Orders Graph', status: 'active', createdAt: new Date().toISOString(), updatedAt: '' },
    provider: { id: 'p-1', name: 'Falkor Docker', providerType: 'falkordb' },
    stats: { nodeCount: 67870, edgeCount: 568001, entityTypeCounts: { Party: 4000 }, edgeTypeCounts: { HOLDS: 5000 } },
    meta: { status: 'fresh', updated_at: new Date().toISOString(), refreshing: false, provider_health: 'ok' },
    consumers: { catalogItems: [], workspaces: [{ id: 'w', name: 'Analytics', type: 'workspace' }], views: [{ id: 'v', name: 'Revenue', type: 'view' }] },
    isLoading: false, statsLoading: false, consumersLoading: false, notFound: false,
  }),
}))
vi.mock('@/store/providerHealthModel', () => ({
  useProviderHealth: () => ({ state: 'ready' }),
  PROVIDER_HEALTH_META: { ready: { dot: 'bg-emerald-400', label: 'Healthy' } },
}))
vi.mock('@/components/insights/StatusChip', () => ({ StatusChip: () => <span data-testid="chip" /> }))
vi.mock('@/services/aggregationService', () => ({
  aggregationService: { getReadiness: vi.fn().mockResolvedValue({ aggregationStatus: 'ready', lastAggregatedAt: new Date().toISOString(), aggregationEdgeCount: 1234, driftDetected: false }) },
}))
vi.mock('@/components/admin/workspace/VocabAlignmentWarning', () => ({ VocabAlignmentWarning: () => <div data-testid="vocab" /> }))

import { DataSourceProfile } from './DataSourceProfile'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('DataSourceProfile', () => {
  it('renders core sections: name, metrics, and consumers', async () => {
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" /></MemoryRouter>)
    expect(screen.getByText('Orders Graph')).toBeInTheDocument()
    expect(screen.getByText('68k')).toBeInTheDocument()          // 67870 compacted
    // "Analytics" legitimately renders twice — Used by AND Explore lineage
    // both list workspaces by name, matching the source page's behavior.
    expect(screen.getAllByText('Analytics').length).toBeGreaterThan(0)
    expect(screen.getByText('Revenue')).toBeInTheDocument()
  })

  it('does not render enhanced sections without context', () => {
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" /></MemoryRouter>)
    expect(screen.queryByText('Semantic layer')).not.toBeInTheDocument()
  })

  it('renders enhanced sections when workspace context is provided', async () => {
    const ctx = { wsId: 'w', dataSourceId: 'ds-1', ontologyId: 'o-1', ontologyName: 'Core Ontology' }
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" context={ctx} /></MemoryRouter>, { wrapper })
    expect(await screen.findByText('Semantic layer')).toBeInTheDocument()
    expect(screen.getByText('Core Ontology')).toBeInTheDocument()
    expect(screen.getByTestId('vocab')).toBeInTheDocument()
  })

  it('suppresses hero + host-duplicated sections when embedded', () => {
    // When embedded in a host that already shows identity + actions (the
    // workspace drawer), the profile must not repeat the hero, explore,
    // ontology link or vocab warning — but the insight content stays.
    const ctx = { wsId: 'w', dataSourceId: 'ds-1', ontologyId: 'o-1', ontologyName: 'Core Ontology' }
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" context={ctx} embedded /></MemoryRouter>, { wrapper })
    expect(screen.queryByRole('heading', { name: 'Orders Graph', level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Semantic layer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vocab')).not.toBeInTheDocument()
    expect(screen.getByText('68k')).toBeInTheDocument()   // insight content still renders
  })
})
