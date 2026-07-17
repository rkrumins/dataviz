/**
 * EvalContextBarView — schema-first applications strip: chips per application,
 * chip-click switching, provenance labels, identity copy, degrade rules.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EvalContextBarView } from './EvalContextBar'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'

const DS1 = { id: 'ds1', label: 'Data Lineage', graphName: 'data_lineage_2', ontologyId: 'bp_1', providerId: 'p1' } as DataSourceResponse
const DS2 = { id: 'ds2', label: 'Sales Graph', graphName: 'sales', ontologyId: 'bp_1', providerId: 'p1' } as DataSourceResponse
const DS_OTHER = { id: 'ds9', label: 'Foreign Source', graphName: 'foreign', ontologyId: 'bp_OTHER', providerId: 'p1' } as DataSourceResponse

const WS = { id: 'ws1', name: 'AGGGG', dataSources: [DS1, DS2, DS_OTHER] } as WorkspaceResponse

const PROVIDER: DataSourceProviderInfo = {
  providerId: 'p1',
  providerName: 'Falkor Docker',
  providerType: 'falkordb',
  sourceIdentifier: 'data_lineage_2',
  host: 'falkordb',
  port: 6379,
}

const resolveProvider = (dsId?: string | null) => (dsId ? PROVIDER : undefined)

function renderBar(overrides: Partial<Parameters<typeof EvalContextBarView>[0]> = {}) {
  const onSelectTarget = vi.fn()
  const onChangeTarget = vi.fn()
  const onManageAssignments = vi.fn()
  render(
    <EvalContextBarView
      ontologyId="bp_1"
      workspaces={[WS]}
      workspace={WS}
      dataSource={DS1}
      selectionSource="auto-assigned"
      onSelectTarget={onSelectTarget}
      onChangeTarget={onChangeTarget}
      onManageAssignments={onManageAssignments}
      resolveProvider={resolveProvider}
      {...overrides}
    />,
  )
  return { onSelectTarget, onChangeTarget, onManageAssignments }
}

describe('EvalContextBarView', () => {
  it('leads with the schema\'s applications and switches analysis on chip click', async () => {
    const user = userEvent.setup()
    const { onSelectTarget } = renderBar()

    expect(screen.getByText(/This schema powers/i)).toBeInTheDocument()
    // Both applications appear as chips (the analyzed one also shows in the
    // identity row); the foreign-ontology source does not.
    expect(screen.getAllByText('Data Lineage').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Sales Graph')).toBeInTheDocument()
    expect(screen.queryByText('Foreign Source')).not.toBeInTheDocument()

    await user.click(screen.getByText('Sales Graph'))
    expect(onSelectTarget).toHaveBeenCalledWith('ws1', 'ds2')
  })

  it('states the analyzed target with graph, workspace, and provider host:port', () => {
    renderBar()
    expect(screen.getByText('Analyzing')).toBeInTheDocument()
    expect(screen.getByText('data_lineage_2')).toBeInTheDocument()
    expect(screen.getByText('AGGGG')).toBeInTheDocument()
    expect(screen.getByText('Falkor Docker')).toBeInTheDocument()
    expect(screen.getByText(/falkordb, falkordb:6379/)).toBeInTheDocument()
  })

  it('explains an auto-selected target', () => {
    renderBar({ selectionSource: 'auto-assigned' })
    const badge = screen.getByText('auto-selected')
    expect(badge).toHaveAttribute('title', expect.stringContaining('first data source using this schema'))
  })

  it('labels a user-picked target as their selection', () => {
    renderBar({ selectionSource: 'user' })
    expect(screen.getByText('your selection')).toBeInTheDocument()
  })

  it('marks the workspace-active fallback as a preview that does not use this schema', () => {
    renderBar({ dataSource: DS_OTHER, selectionSource: 'workspace-active' })
    expect(screen.getByText('Previewing against')).toBeInTheDocument()
    const badge = screen.getByText(/preview · not using this schema/)
    expect(badge).toHaveAttribute('title', expect.stringContaining('workspace-active source'))
  })

  it('omits the provider segment entirely on degraded resolution (non-admin)', () => {
    renderBar({
      resolveProvider: () => ({ providerId: 'p1', providerName: 'p1', providerType: 'unknown' }),
    })
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument()
    expect(screen.queryByText('Falkor Docker')).not.toBeInTheDocument()
    // Graph name still shown from the DS row itself
    expect(screen.getByText('data_lineage_2')).toBeInTheDocument()
  })

  it('collapses large fleets behind a +N more affordance that opens the picker', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...DS1, id: `ds_m${i}`, label: `Source ${i}`,
    })) as DataSourceResponse[]
    const bigWs = { ...WS, dataSources: many } as WorkspaceResponse
    const { onChangeTarget } = renderBar({
      workspaces: [bigWs], workspace: bigWs, dataSource: many[0],
    })
    expect(screen.getByText('+3 more')).toBeInTheDocument()
    await user.click(screen.getByText('+3 more'))
    expect(onChangeTarget).toHaveBeenCalled()
  })

  it('offers Assign when the schema has no applications, and Manage otherwise', async () => {
    const user = userEvent.setup()
    const emptyWs = { ...WS, dataSources: [DS_OTHER] } as WorkspaceResponse
    const { onManageAssignments } = renderBar({
      workspaces: [emptyWs], dataSource: null, workspace: null,
    })
    expect(screen.getByText(/no data sources yet/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing to analyze yet/)).toBeInTheDocument()
    await user.click(screen.getByText('Assign'))
    expect(onManageAssignments).toHaveBeenCalled()
  })
})
