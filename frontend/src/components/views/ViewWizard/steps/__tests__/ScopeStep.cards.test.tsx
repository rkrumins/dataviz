/**
 * ScopeStep — data-source card geometry.
 *
 * The cards were visibly ragged: a source whose name wrapped, or whose metrics
 * wrapped to a second line, grew taller than the ones beside it, and the footers
 * in a row didn't line up. Worse, the grid changed its column count based on how
 * many sources a PAGE happened to hold — so the last page of a paginated list
 * rendered cards at a completely different width from the first.
 *
 * These are structural assertions (does the card fill its cell, does the footer
 * get pinned, is the grid fixed) rather than pixel measurements: jsdom has no
 * layout engine, so the classes ARE the contract here.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSourceResponse, WorkspaceResponse } from '@/services/workspaceService'

vi.mock('@/hooks/useDataSourceStats', () => ({
  useDataSourceStats: () => ({ statsMap: {}, isLoading: false }),
}))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({
  useDataSourceProviderMap: () => ({ map: {}, resolve: () => undefined }),
}))
vi.mock('@/hooks/useWorkspacePage', () => ({
  useWorkspacePage: () => ({
    workspaces: [], totalCount: 1, isLoading: false, isError: false, refetch: vi.fn(),
  }),
}))
vi.mock('@/store/providerHealthModel', () => ({
  useProviderHealth: () => ({ state: 'unknown' }),
  PROVIDER_HEALTH_META: {
    unknown: { dot: 'bg-slate-300', label: 'Unknown', selectable: true },
  },
}))

import { ScopeStep } from '../ScopeStep'

function makeDataSource(over: Partial<DataSourceResponse> = {}): DataSourceResponse {
  return {
    id: 'ds1',
    workspaceId: 'ws1',
    providerId: 'p1',
    label: 'Pipeline',
    accessLevel: 'read',
    isPrimary: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    aggregationStatus: 'none',
    aggregationEdgeCount: 0,
    ...over,
  } as DataSourceResponse
}

function renderScope(dataSources: DataSourceResponse[]) {
  const workspace: WorkspaceResponse = {
    id: 'ws1',
    name: 'Major Refactor Agg',
    dataSources,
    isDefault: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as WorkspaceResponse

  return render(
    <ScopeStep
      availableWorkspaces={[workspace]}
      schemaAvailability={{ hasOntology: true, status: 'ready', message: null }}
      selectedWorkspaceId="ws1"
      selectedDataSourceId={null}
      activeWorkspaceId="ws1"
      onSelectWorkspace={vi.fn()}
      onSelectDataSource={vi.fn()}
      scopeMode="existing"
      onScopeModeChange={vi.fn()}
      providers={[]}
      ontologies={[]}
      blankOptionsLoading={false}
      selectedProviderId={null}
      selectedOntologyId={null}
      onSelectProvider={vi.fn()}
      onSelectOntology={vi.fn()}
    />
  )
}

/** The card is the button wrapping a data source's name. */
function cardFor(name: string): HTMLElement {
  const heading = screen.getByText(name)
  const card = heading.closest('button')
  if (!card) throw new Error(`no card button around "${name}"`)
  return card
}

describe('ScopeStep — every card is the same size', () => {
  it('lets each card fill its grid cell, so a taller neighbour cannot shrink it', () => {
    renderScope([
      makeDataSource({ id: 'ds1', label: 'Pipeline' }),
      // A name long enough to wrap onto a second line — this is the one that used
      // to make its own card taller than the rest of the row.
      makeDataSource({ id: 'ds2', label: 'Perf-Load-Test-Solidatus' }),
    ])

    for (const name of ['Pipeline', 'Perf-Load-Test-Solidatus']) {
      const card = cardFor(name)
      expect(card.className).toContain('h-full')
      expect(card.className).toContain('flex-col')
    }
  })

  it('pins the status footer to the bottom so footers line up across a row', () => {
    renderScope([makeDataSource({ label: 'Pipeline' })])

    const footer = cardFor('Pipeline').querySelector('.mt-auto')
    expect(footer).not.toBeNull()
    // It's the status row, not some other block that happened to grab mt-auto.
    expect(footer?.textContent).toContain('Not run')
  })

  it('reserves the name and metric blocks so short and long cards stay in step', () => {
    renderScope([makeDataSource({ label: 'Pipeline' })])
    const card = cardFor('Pipeline')

    // Two lines of name are reserved whether or not the name needs them...
    expect(card.querySelector('.min-h-\\[2\\.5rem\\]')).not.toBeNull()
    // ...and the metrics are a fixed 3-column block rather than an inline row that
    // wraps for busy sources and not for quiet ones.
    expect(card.querySelector('.grid-cols-3, .min-h-\\[38px\\]')).not.toBeNull()
  })

  it('keeps the SAME column count regardless of how many sources a page holds', () => {
    // The old grid switched to `grid-cols-1 max-w-md` for a single source and two
    // columns for a pair — so a last page holding 1–2 sources rendered cards at a
    // completely different width from the full pages before it.
    const { container: single } = renderScope([makeDataSource({ label: 'Only One' })])
    const singleGrid = single.querySelector('.grid.gap-3')
    expect(singleGrid?.className).toContain('lg:grid-cols-3')
    expect(singleGrid?.className).not.toContain('max-w-md')
  })
})
