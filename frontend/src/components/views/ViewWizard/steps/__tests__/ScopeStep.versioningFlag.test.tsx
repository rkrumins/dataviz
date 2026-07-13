/**
 * ScopeStep — "Start from blank" must DISAPPEAR when version control is off.
 *
 * A blank model IS a versioned model: it exists only as drafts and commits, and the server
 * refuses to create one with the feature disabled. The flag was already read here, but only to
 * hide the panel BEHIND the choice and to bounce the user back to "Use existing data" if they
 * picked it. The chip itself was in a hard-coded array and always rendered — so an admin could
 * turn version control off and still be looking at a "Start from blank" button that, when
 * clicked, silently flipped back and explained nothing. If it cannot be chosen, do not show it.
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

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { ScopeStep } from '../ScopeStep'

function setVersioning(on: boolean) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: on } })
}

function renderScope() {
  const ws = {
    id: 'ws1', name: 'WS', dataSources: [] as DataSourceResponse[], isDefault: false,
    isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as WorkspaceResponse
  return render(
    <ScopeStep
      availableWorkspaces={[ws]}
      schemaAvailability={{ hasOntology: true, status: 'ready', message: null }}
      selectedWorkspaceId="ws1"
      selectedDataSourceId={null}
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

describe('ScopeStep · the versioningEnabled gate', () => {
  it('offers "Start from blank" when version control is ON', () => {
    setVersioning(true)
    renderScope()
    expect(screen.getByText('Start from blank')).toBeInTheDocument()
  })

  it('does NOT offer it when an admin has turned version control OFF', () => {
    setVersioning(false)
    renderScope()
    expect(screen.queryByText('Start from blank')).not.toBeInTheDocument()
  })

  it('does not leave a lone "Use existing data" toggle with nothing to toggle to', () => {
    setVersioning(false)
    renderScope()
    // With only one mode left there is no choice to present, so the whole control goes.
    expect(screen.queryByText('Use existing data')).not.toBeInTheDocument()
  })
})
