/**
 * ScopeStep · a blank graph in the Playground with no starter data model to pick used to end at
 * "Manage semantic layers" — a page a Playground member can't use. There it offers the two
 * starts that make a data model of their own: a sample, or their own data, back on the
 * Playground's front page (the wizard closes on the way). Everywhere else nothing changes.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSourceResponse, WorkspaceResponse } from '@/services/workspaceService'

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

function renderScope(kind?: string) {
  const ws = {
    id: 'ws1', name: kind === 'playground' ? 'Playground' : 'Sales', kind, dataSources: [] as DataSourceResponse[], isDefault: false,
    isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as WorkspaceResponse
  return render(
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
          onSelectOntology={vi.fn()}
        />
      </ViewEditorContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  closeViewEditor.mockReset()
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, blankModelsEnabled: true } })
})

describe('ScopeStep · no data model to start from, in the Playground', () => {
  it('offers a sample or your own data instead of a page the member can’t use', async () => {
    renderScope('playground')
    expect(screen.getByText('Starter data model')).toBeInTheDocument()
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
