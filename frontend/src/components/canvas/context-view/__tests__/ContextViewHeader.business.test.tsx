/**
 * ContextViewHeader in the Business view — the row keeps what reading a view
 * needs and tucks the rest into More, which holds it rather than dropping it.
 * The Technical view keeps every tool on the row, exactly as before.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { stubSession } from '@/test/stubSearchSession'

vi.mock('@/features/versioning/components/BranchSwitcher', () => ({
  BranchSwitcher: () => <div data-testid="branch-switcher" />,
}))

import { ContextViewHeader, type ContextViewHeaderProps } from '../ContextViewHeader'

function baseProps(overrides: Partial<ContextViewHeaderProps> = {}): ContextViewHeaderProps {
  return {
    showLineageFlow: true,
    onToggleLineageFlow: vi.fn(),
    showEdgeDirection: false,
    onToggleEdgeDirection: vi.fn(),
    lineageRenderMode: 'stubs',
    onSetLineageRenderMode: vi.fn(),
    traceActive: false,
    canTrace: true,
    onStartTrace: vi.fn(),
    onExitTrace: vi.fn(),
    lineageReady: true,
    traceUpstreamDepth: 3,
    traceDownstreamDepth: 3,
    onSetTraceDepth: vi.fn(),
    isDraft: false,
    canManage: false,
    canEnterEdit: true,
    onEnterEdit: vi.fn(),
    onExitEdit: vi.fn(),
    onTogglePropertyManager: vi.fn(),
    propertyManagerOpen: false,
    onToggleMultiSelect: vi.fn(),
    multiSelectArmed: false,
    onOpenLens: vi.fn(),
    traceHistory: [{ index: 0, label: 'Orders', mode: 'both', timestamp: Date.now() }],
    onResumeTraceHistory: vi.fn(),
    branchWorkspaceId: 'ws-1',
    syncStatus: 'idle',
    onRetrySync: vi.fn(),
    pendingChangeCount: 0,
    onOpenStagedChanges: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canvasZoom: 1,
    onSetCanvasZoom: vi.fn(),
    canvasDensity: 'spacious',
    onSetCanvasDensity: vi.fn(),
    showCanvasTypeBadge: true,
    onToggleCanvasTypeBadge: vi.fn(),
    subtleCanvasTreeLines: false,
    onToggleSubtleCanvasTreeLines: vi.fn(),
    onResetCanvasDisplaySettings: vi.fn(),
    ...overrides,
  }
}

function renderHeader(props: ContextViewHeaderProps) {
  return render(
    <ViewSearchSessionContext.Provider value={stubSession()}>
      <ContextViewHeader {...props} />
    </ViewSearchSessionContext.Provider>,
  )
}

describe('ContextViewHeader — Business view', () => {
  beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('keeps what reading needs on the row', () => {
    renderHeader(baseProps())
    expect(screen.getByRole('button', { name: 'Lineage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Focus Lens/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trace Lineage/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More tools' })).toBeInTheDocument()
  })

  it('tucks Select, Properties, Import / Export, trace history and the branch switcher away', () => {
    renderHeader(baseProps())
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Properties' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import / Export' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trace history' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument()
  })

  it('holds what it tucks away in More', async () => {
    const props = baseProps()
    renderHeader(props)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select several/ }))
    expect(props.onToggleMultiSelect).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /Properties & display rules/ }))
    expect(props.onTogglePropertyManager).toHaveBeenCalledTimes(1)
  })

  it('never hides a tool while it is on', () => {
    renderHeader(baseProps({ multiSelectArmed: true, propertyManagerOpen: true }))
    expect(screen.getByRole('button', { name: 'Selecting' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
  })

  it('shows the branch switcher in a draft, where it says which draft this is', () => {
    renderHeader(baseProps({ isDraft: true }))
    expect(screen.getByTestId('branch-switcher')).toBeInTheDocument()
  })
})

describe('ContextViewHeader — Technical view', () => {
  it('keeps every tool on the row, and has no More', () => {
    renderHeader(baseProps())
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import / Export' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace history' })).toBeInTheDocument()
    expect(screen.getByTestId('branch-switcher')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More tools' })).not.toBeInTheDocument()
  })
})
