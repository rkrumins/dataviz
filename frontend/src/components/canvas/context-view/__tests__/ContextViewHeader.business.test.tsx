/**
 * ContextViewHeader in the Business view — the row keeps what reading a view
 * needs, Properties and the Import / Export menu (the same one the Technical
 * view has), and tucks the rest into More, which holds it rather than dropping
 * it. More is not drawn when it has nothing to hold. A draft keeps its Connect
 * tool on the row too. The Technical view keeps every tool on the row, exactly
 * as before.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { stubSession } from '@/test/stubSearchSession'

vi.mock('@/features/versioning/components/BranchSwitcher', () => ({
  BranchSwitcher: ({ managerOpen }: { managerOpen?: boolean }) => (
    <div data-testid="branch-switcher" data-manager-open={String(!!managerOpen)} />
  ),
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

  it('keeps what reading needs on the row, with Properties and Import / Export', () => {
    renderHeader(baseProps())
    expect(screen.getByRole('button', { name: 'Lineage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Focus Lens/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trace Lineage/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import / Export' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More tools' })).toBeInTheDocument()
  })

  it('tucks Select and trace history away', () => {
    renderHeader(baseProps())
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trace history' })).not.toBeInTheDocument()
  })

  it('opens the Property Manager from the row', async () => {
    const props = baseProps()
    renderHeader(props)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Properties' }))
    expect(props.onTogglePropertyManager).toHaveBeenCalledTimes(1)
  })

  describe('the Import / Export menu, the same as the Technical view’s', () => {
    beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, viewPortabilityEnabled: true } }))
    afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

    it('exports the data, the view, and the view with its data', async () => {
      const thisView = { onExport: vi.fn(), onExportWithData: vi.fn() }
      const props = baseProps({ onExport: vi.fn(), thisView })
      renderHeader(props)
      const user = userEvent.setup()
      const openMenu = async () => {
        await user.click(screen.getByRole('button', { name: 'Import / Export' }))
        return screen.findByRole('menu', { name: 'Import and export' })
      }

      await user.click(within(await openMenu()).getByRole('menuitem', { name: /^Export…/ }))
      expect(props.onExport).toHaveBeenCalledTimes(1)
      await user.click(within(await openMenu()).getByRole('menuitem', { name: /^Export view…/ }))
      expect(thisView.onExport).toHaveBeenCalledTimes(1)
      await user.click(within(await openMenu()).getByRole('menuitem', { name: /^Export view \+ data…/ }))
      expect(thisView.onExportWithData).toHaveBeenCalledTimes(1)
    })
  })

  it('shows the branch switcher on Published, as the Technical view does — open drafts are a click away', () => {
    renderHeader(baseProps())
    expect(screen.getByTestId('branch-switcher')).toBeVisible()
  })

  it('holds what it tucks away in More, and nothing the row already has', async () => {
    const props = baseProps({ onImport: vi.fn(), onExport: vi.fn() })
    renderHeader(props)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: /Properties & display rules/ })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /^Import…/ })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('group', { name: 'File' })).not.toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /Select several/ }))
    expect(props.onToggleMultiSelect).toHaveBeenCalledTimes(1)
  })

  it('draws no More when it has nothing to hold', () => {
    // No Select (a host that does not wire it) and no drafts manager (no right to edit).
    renderHeader(baseProps({ onToggleMultiSelect: undefined, canEnterEdit: false }))
    expect(screen.queryByRole('button', { name: 'More tools' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import / Export' })).toBeInTheDocument()
  })

  it('never hides a tool while it is on', () => {
    renderHeader(baseProps({ multiSelectArmed: true, propertyManagerOpen: true }))
    expect(screen.getByRole('button', { name: 'Selecting' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
  })

  it('shows the branch switcher in a draft, where it says which draft this is', () => {
    renderHeader(baseProps({ isDraft: true }))
    expect(screen.getByTestId('branch-switcher')).toBeVisible()
  })

  it('in a draft, keeps Connect on the row and Import in the Import / Export menu', async () => {
    const props = baseProps({ isDraft: true, onToggleConnectTool: vi.fn(), onImport: vi.fn() })
    renderHeader(props)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(props.onToggleConnectTool).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Import / Export' }))
    await user.click(await screen.findByRole('menuitem', { name: /^Import…/ }))
    expect(props.onImport).toHaveBeenCalledTimes(1)
  })

  it('on Published, Import waits for a draft, and "Your drafts…" opens the drafts manager', async () => {
    const props = baseProps({ onImport: vi.fn() })
    renderHeader(props)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Import / Export' }))
    expect(await screen.findByRole('menuitem', { name: /^Import…/ })).toBeDisabled()
    await user.keyboard('{Escape}')

    expect(screen.getByTestId('branch-switcher')).toHaveAttribute('data-manager-open', 'false')
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /^Your drafts…/ }))
    expect(screen.getByTestId('branch-switcher')).toHaveAttribute('data-manager-open', 'true')
  })

  it('leaves the view’s changes and history to Reviews in the page header', async () => {
    renderHeader(baseProps())
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: /Changes & history/ })).not.toBeInTheDocument()
  })

  it('offers "Entities with no parent…" in a draft only', async () => {
    const onOpenOrphans = vi.fn()
    const user = userEvent.setup()
    const published = renderHeader(baseProps({ onOpenOrphans }))
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: /^Entities with no parent…/ })).not.toBeInTheDocument()
    published.unmount()

    renderHeader(baseProps({ isDraft: true, onOpenOrphans }))
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /^Entities with no parent…/ }))
    expect(onOpenOrphans).toHaveBeenCalledTimes(1)
  })
})

describe('ContextViewHeader — Technical view', () => {
  it('keeps every tool on the row, and has no More', () => {
    renderHeader(baseProps())
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import / Export' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace history' })).toBeInTheDocument()
    expect(screen.getByTestId('branch-switcher')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'More tools' })).not.toBeInTheDocument()
  })
})
