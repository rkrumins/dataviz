/**
 * ScopeStep — finding a data source you can't see.
 *
 * A data source belongs to exactly ONE workspace, so picking it settles the
 * workspace too. The rail is a browsing aid, not a decision the user owes us
 * first — and in a real estate most workspaces are empty, so making people
 * navigate one to reach a source is asking them to search a haystack for the
 * shape of the needle.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSourceResponse, WorkspaceResponse } from '@/services/workspaceService'

vi.mock('@/hooks/useDataSourceStats', () => ({
  useDataSourceStats: () => ({ statsMap: {}, isLoading: false }),
}))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({
  useDataSourceProviderMap: () => ({ map: {}, resolve: () => undefined }),
}))
// The rail is server-paged, so its rows come from this hook — NOT from the
// availableWorkspaces prop, which feeds the cards. (Lazy body: HOME/ELSEWHERE are
// resolved at render, long after the factory is hoisted.)
vi.mock('@/hooks/useWorkspacePage', () => ({
  useWorkspacePage: () => ({
    workspaces: [HOME, ELSEWHERE], totalCount: 2, isLoading: false, isError: false, refetch: vi.fn(),
  }),
}))
vi.mock('@/store/providerHealthModel', () => ({
  useProviderHealth: () => ({ state: 'unknown' }),
  PROVIDER_HEALTH_META: { unknown: { dot: 'bg-slate-300', label: 'Unknown', selectable: true } },
}))

import { ScopeStep } from '../ScopeStep'

function makeDs(id: string, label: string, workspaceId: string): DataSourceResponse {
  return {
    id, workspaceId, providerId: 'p1', label,
    accessLevel: 'read', isPrimary: false, isActive: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    aggregationStatus: 'none', aggregationEdgeCount: 0,
  } as DataSourceResponse
}

function makeWs(id: string, name: string, dataSources: DataSourceResponse[]): WorkspaceResponse {
  return {
    id, name, dataSources, isDefault: false, isActive: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as WorkspaceResponse
}

// "Home" is where you are; the thing you want lives in "Elsewhere".
const HOME = makeWs('ws1', 'Home', [makeDs('ds1', 'Billing Pipeline', 'ws1')])
const ELSEWHERE = makeWs('ws2', 'Elsewhere', [makeDs('ds2', 'Layered Lineage', 'ws2')])
const EMPTY = makeWs('ws3', 'Empty Space', [])

function renderScope(over: {
  workspaces?: WorkspaceResponse[]
  selectedWorkspaceId?: string
  onSelectWorkspace?: (id: string) => void
  onSelectDataSource?: (id: string) => void
} = {}) {
  return render(
    <ScopeStep
      availableWorkspaces={over.workspaces ?? [HOME, ELSEWHERE]}
      schemaAvailability={{ hasOntology: true, status: 'ready', message: null }}
      selectedWorkspaceId={over.selectedWorkspaceId ?? 'ws1'}
      selectedDataSourceId={null}
      onSelectWorkspace={over.onSelectWorkspace ?? vi.fn()}
      onSelectDataSource={over.onSelectDataSource ?? vi.fn()}
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

const search = () => screen.getByPlaceholderText(/Search data sources/i)

describe('ScopeStep — searching beyond the current workspace', () => {
  it('offers a way out when the match is in another workspace', () => {
    renderScope()
    fireEvent.change(search(), { target: { value: 'layered' } })

    // Nothing here — but we know exactly where it is, so say so instead of
    // showing a bare "no results" and letting them hunt the rail. (The count sits
    // in its own element, so match the whole line.)
    expect(
      screen.getByText((_c, el) =>
        el?.tagName === 'SPAN' && /1 match in other workspaces/i.test(el.textContent ?? '')),
    ).toBeInTheDocument()
    expect(screen.queryByText('Layered Lineage')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Search all/i }))
    expect(screen.getByText('Layered Lineage')).toBeInTheDocument()
  })

  it('says which workspace a foreign source lives in', () => {
    renderScope()
    fireEvent.click(screen.getByRole('button', { name: /All workspaces/i }))

    // Picking it moves the whole view to that workspace, so it can't be silent.
    const card = screen.getByText('Layered Lineage').closest('button')
    expect(card?.textContent).toContain('Elsewhere')
    // A source in the workspace you're already browsing needs no such chip.
    expect(screen.getByText('Billing Pipeline').closest('button')?.textContent)
      .not.toContain('Elsewhere')
  })

  it('picking a foreign source settles its workspace too', () => {
    const onSelectWorkspace = vi.fn()
    const onSelectDataSource = vi.fn()
    renderScope({ onSelectWorkspace, onSelectDataSource })

    fireEvent.click(screen.getByRole('button', { name: /All workspaces/i }))
    fireEvent.click(screen.getByText('Layered Lineage'))

    // Both, or the wizard would build the view in the wrong place.
    expect(onSelectWorkspace).toHaveBeenCalledWith('ws2')
    expect(onSelectDataSource).toHaveBeenCalledWith('ds2')
  })

  it('an empty workspace is not a dead end', () => {
    // Most workspaces in a real estate hold nothing. Landing on one used to mean
    // no search box at all — the one screen where you most need it.
    renderScope({ workspaces: [HOME, ELSEWHERE, EMPTY], selectedWorkspaceId: 'ws3' })

    expect(screen.getByText(/has no data sources/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Browse all 2 sources/i }))

    expect(screen.getByText('Layered Lineage')).toBeInTheDocument()
    expect(screen.getByText('Billing Pipeline')).toBeInTheDocument()
  })

  it('marks exactly one workspace as the one you are on', () => {
    // The app's global "active workspace" is retired. While it lingered, the rail
    // pinned it above the list and chipped it green — so two workspaces could read
    // as chosen at once: the pinned one, and the one the wizard had actually
    // selected. In this wizard the selection is the only "you are here" there is.
    renderScope({ selectedWorkspaceId: 'ws2' })

    expect(screen.queryByText(/current workspace/i)).not.toBeInTheDocument()
    expect(screen.queryByText('active')).not.toBeInTheDocument()
    // 'Home' (ws1, the old global "active") appears once — as an ordinary row. The
    // pin drew it a second time, and from the store rather than the paged rail, so
    // it could even show a workspace the pager said wasn't on this page.
    expect(screen.getAllByText('Home')).toHaveLength(1)
  })
})
