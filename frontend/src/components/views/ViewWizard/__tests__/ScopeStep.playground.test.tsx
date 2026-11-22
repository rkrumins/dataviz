/**
 * ScopeStep · a blank graph in the Playground starts from a data model the Playground offers the
 * member (`GET /playground/models`): approved ones, shared ones, their own, starters and samples,
 * each saying which it is. With none to pick, it used to end at "Manage semantic layers" — a page
 * a Playground member can't use. There it offers the two starts that make a data model of their
 * own: a sample, or their own data, back on the Playground's front page (the wizard closes on the
 * way). Everywhere else nothing changes.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSourceResponse, WorkspaceResponse } from '@/services/workspaceService'

const { listModels } = vi.hoisted(() => ({ listModels: vi.fn() }))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { listModels } }))

vi.mock('@/hooks/useDataSourceStats', () => ({ useDataSourceStats: () => ({ statsMap: {}, isLoading: false }) }))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({ useDataSourceProviderMap: () => ({ map: {}, resolve: () => undefined }) }))
vi.mock('@/hooks/useWorkspacePage', () => ({
  useWorkspacePage: () => ({ workspaces: [], totalCount: 1, isLoading: false, isError: false, refetch: vi.fn() }),
}))
vi.mock('@/store/providerHealthModel', () => ({
  useProviderHealth: () => ({ state: 'unknown' }),
  PROVIDER_HEALTH_META: { unknown: { dot: 'bg-slate-300', label: 'Unknown', selectable: true } },
}))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { ScopeStep } from '../steps/ScopeStep'

const closeViewEditor = vi.fn()
const onSelectOntology = vi.fn()

function renderScope(kind?: string) {
  const ws = {
    id: 'ws1', name: kind === 'playground' ? 'Playground' : 'Sales', kind, dataSources: [] as DataSourceResponse[], isDefault: false,
    isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as WorkspaceResponse
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
    <MemoryRouter>
      <ViewEditorContext.Provider value={{ openViewEditor: vi.fn(), closeViewEditor }}>
        <ScopeStep
          availableWorkspaces={[ws]}
          schemaAvailability={{ hasOntology: true, status: 'ready', message: null }}
          selectedWorkspaceId="ws1"
          selectedDataSourceId={null}
          onSelectWorkspace={vi.fn()}
          onSelectDataSource={vi.fn()}
          scopeMode="blank"
          onScopeModeChange={vi.fn()}
          providers={[]}
          ontologies={[]}
          blankOptionsLoading={false}
          selectedProviderId={null}
          selectedOntologyId={null}
          onSelectProvider={vi.fn()}
          onSelectOntology={onSelectOntology}
        />
      </ViewEditorContext.Provider>
    </MemoryRouter>
    </QueryClientProvider>,
  )
}

const model = (id: string, name: string, kind: string, isPublished = true) => ({
  id, name, kind, isPublished, description: null, version: 1, entityTypeCount: 4, relationshipTypeCount: 2, usedBy: 0,
})

beforeEach(() => {
  closeViewEditor.mockReset()
  onSelectOntology.mockReset()
  listModels.mockReset().mockResolvedValue([])
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, blankModelsEnabled: true, playgroundEnabled: true } })
})

describe('ScopeStep · the data models the Playground offers', () => {
  it('lists them, each saying where it comes from, in place of the org’s semantic layers', async () => {
    listModels.mockResolvedValue([
      model('ont_pipes', 'Data pipelines', 'approved'), model('ont_mine', 'My shop model', 'yours'),
      model('ont_theirs', 'Ada’s model', 'shared'), model('bp_starter', 'Starter graph', 'starter'),
      model('bp_retail', 'Retail sample', 'sample'), model('ont_draft', 'Half done', 'yours', false),
    ])
    renderScope('playground')
    const approved = await screen.findByRole('button', { name: /Data pipelines/ })
    expect(screen.getByText('Data model')).toBeInTheDocument()
    expect(approved).toHaveTextContent('Approved')
    expect(approved).toHaveTextContent('4entities')
    expect(screen.getByRole('button', { name: /My shop model/ })).toHaveTextContent('Yours')
    expect(screen.getByRole('button', { name: /Ada’s model/ })).toHaveTextContent('Shared')
    expect(screen.getByRole('button', { name: /Starter graph/ })).toHaveTextContent('Starter')
    expect(within(screen.getByRole('button', { name: /Retail sample/ })).getByText('Sample')).toBeInTheDocument()
    expect(screen.queryByText('Half done')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /My shop model/ }))
    expect(onSelectOntology).toHaveBeenCalledWith('ont_mine')
  })
})

describe('ScopeStep · no data model to start from, in the Playground', () => {
  it('offers a sample or your own data instead of a page the member can’t use', async () => {
    renderScope('playground')
    expect(await screen.findByText('No starter data models yet')).toBeInTheDocument()
    expect(screen.getByText('Data model')).toBeInTheDocument()
    expect(screen.queryByText('Manage semantic layers')).toBeNull()
    const sample = screen.getByRole('link', { name: /Start from a sample/ })
    expect(sample).toHaveAttribute('href', '/playground?start=samples')
    expect(screen.getByRole('link', { name: /Bring your own data/ })).toHaveAttribute('href', '/playground?start=import')
    await userEvent.click(sample)
    expect(closeViewEditor).toHaveBeenCalled()
  })

  it('is unchanged in any other workspace', () => {
    renderScope()
    expect(screen.getByText('No published semantic layers')).toBeInTheDocument()
    expect(screen.getByText('Manage semantic layers')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Start from a sample/ })).toBeNull()
  })
})
