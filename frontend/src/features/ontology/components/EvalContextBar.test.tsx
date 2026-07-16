/**
 * EvalContextBarView — identity copy, assigned/preview badge, degrade rules.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EvalContextBarView } from './EvalContextBar'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'

const WS = { id: 'ws1', name: 'Prod' } as WorkspaceResponse
const DS = {
  id: 'ds1', label: 'Falkor Main', graphName: 'main_graph', ontologyId: 'bp_1', providerId: 'p1',
} as DataSourceResponse

const PROVIDER = {
  providerId: 'p1',
  providerName: 'Falkor Prod',
  providerType: 'falkordb',
  sourceIdentifier: 'main_graph',
  host: 'falkor.internal',
  port: 6379,
}

describe('EvalContextBarView', () => {
  it('states data source, graph, workspace, and provider with host:port', () => {
    render(
      <EvalContextBarView ontologyId="bp_1" workspace={WS} dataSource={DS} providerInfo={PROVIDER} onChangeTarget={() => {}} />,
    )
    expect(screen.getByText('Evaluating')).toBeInTheDocument()
    expect(screen.getByText('Falkor Main')).toBeInTheDocument()
    expect(screen.getByText('main_graph')).toBeInTheDocument()
    expect(screen.getByText('Prod')).toBeInTheDocument()
    expect(screen.getByText('Falkor Prod')).toBeInTheDocument()
    expect(screen.getByText(/falkordb, falkor\.internal:6379/)).toBeInTheDocument()
  })

  it('shows the assigned badge when the source uses this layer', () => {
    render(
      <EvalContextBarView ontologyId="bp_1" workspace={WS} dataSource={DS} providerInfo={PROVIDER} onChangeTarget={() => {}} />,
    )
    expect(screen.getByText('assigned')).toBeInTheDocument()
  })

  it('shows the preview badge when the source uses a different layer', () => {
    render(
      <EvalContextBarView
        ontologyId="bp_OTHER" workspace={WS} dataSource={DS} providerInfo={PROVIDER} onChangeTarget={() => {}}
      />,
    )
    expect(screen.getByText('preview')).toBeInTheDocument()
    expect(screen.getByText('preview')).toHaveAttribute('title', expect.stringContaining("doesn't use this layer yet"))
  })

  it('omits the provider segment entirely on degraded resolution (non-admin)', () => {
    render(
      <EvalContextBarView
        ontologyId="bp_1" workspace={WS} dataSource={DS}
        providerInfo={{ providerId: 'p1', providerName: 'p1', providerType: 'unknown' }}
        onChangeTarget={() => {}}
      />,
    )
    expect(screen.queryByText(/on /)).not.toBeInTheDocument()
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument()
    // Graph name still shown from the DS row itself
    expect(screen.getByText('main_graph')).toBeInTheDocument()
  })

  it('omits host when the provider has none', () => {
    render(
      <EvalContextBarView
        ontologyId="bp_1" workspace={WS} dataSource={DS}
        providerInfo={{ ...PROVIDER, host: undefined, port: undefined }}
        onChangeTarget={() => {}}
      />,
    )
    expect(screen.getByText(/\(falkordb\)/)).toBeInTheDocument()
  })

  it('renders the empty state with a Change affordance when no target resolves', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <EvalContextBarView ontologyId="bp_1" workspace={null} dataSource={null} onChangeTarget={onChange} />,
    )
    expect(screen.getByText(/No evaluation target/)).toBeInTheDocument()
    await user.click(screen.getByText('Change'))
    expect(onChange).toHaveBeenCalled()
  })
})
