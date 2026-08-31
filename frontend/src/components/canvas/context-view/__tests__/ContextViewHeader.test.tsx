/**
 * ContextViewHeader — View/Edit mode partition tests.
 *
 * Published is strictly read-only for everybody; "edit mode" IS being on a
 * draft. These specs pin the mode contract: viewers see zero mutation
 * affordances, managers get a (gateable) Edit entry, and the draft header
 * swaps in the authoring cluster while keeping every comprehension tool.
 * Everything but search renders from plain props; the search box reads the
 * canvas's one session off a context, so every render here provides a
 * stub one.
 *
 * The left slot no longer holds a title. It held the view's name and type
 * count, both of which the PAGE HEADER above prints larger — and between the
 * two sat a third band whose idle state was a branch switcher and a Reviews
 * button. The switcher came down into this slot; the name, the count and the
 * title menu's actions went up. These specs pin that the duplicate is gone and
 * that nothing the block carried was simply dropped on the floor.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import { stubSession } from '@/test/stubSearchSession'

// The switcher is a store + react-query citizen with its own suite; here it
// only needs to prove it lands in the slot on the terms the header sets.
vi.mock('@/features/versioning/components/BranchSwitcher', () => ({
  BranchSwitcher: ({ workspaceId, dataSourceId }: { workspaceId: string; dataSourceId: string | null }) => (
    <div data-testid="branch-switcher" data-ws={workspaceId} data-ds={dataSourceId ?? ''} />
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
    canTrace: false,
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

describe('ContextViewHeader — View mode (Published)', () => {
  it('shows a viewer zero mutation affordances', () => {
    renderHeader(baseProps())

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo' })).not.toBeInTheDocument()
    expect(screen.queryByText(/review & save/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/add entity/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('gives a manager the Edit entry and fires onEnterEdit on click', () => {
    const props = baseProps({ canManage: true, canEnterEdit: true })
    renderHeader(props)

    const edit = screen.getByRole('button', { name: 'Edit' })
    fireEvent.click(edit)
    expect(props.onEnterEdit).toHaveBeenCalledTimes(1)
  })

  it('disables Edit with an explanation when version control is not set up', () => {
    const props = baseProps({ canManage: true, canEnterEdit: false })
    renderHeader(props)

    const edit = screen.getByRole('button', { name: 'Edit' })
    expect(edit).toBeDisabled()
    expect(edit).toHaveAttribute('title', "Version control isn't set up for this data source yet")
    fireEvent.click(edit)
    expect(props.onEnterEdit).not.toHaveBeenCalled()
  })
})

describe('ContextViewHeader — Edit mode (on a draft)', () => {
  it('swaps in the authoring cluster and keeps every comprehension tool', () => {
    renderHeader(baseProps({ isDraft: true, canManage: true }))

    // Authoring cluster present
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument()
    // Undo/Redo carry visible word labels — self-explanatory, not icon-only.
    expect(screen.getByText('Undo')).toBeInTheDocument()
    expect(screen.getByText('Redo')).toBeInTheDocument()
    expect(screen.getByText(/review & save/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    // The Edit entry belongs to View mode only
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()

    // Comprehension tools survive the mode switch
    expect(screen.getByRole('button', { name: 'Lineage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Display' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /trace lineage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /properties/i })).toBeInTheDocument()
  })

  it('disables Review & Save at zero pending changes', () => {
    const props = baseProps({ isDraft: true, pendingChangeCount: 0 })
    renderHeader(props)

    const review = screen.getByRole('button', { name: /review & save/i })
    expect(review).toBeDisabled()
    fireEvent.click(review)
    expect(props.onOpenStagedChanges).not.toHaveBeenCalled()
  })

  it('shows the count chip and opens the review panel when changes are pending', () => {
    const props = baseProps({ isDraft: true, pendingChangeCount: 3 })
    renderHeader(props)

    const review = screen.getByRole('button', { name: /review & save/i })
    expect(review).not.toBeDisabled()
    expect(screen.getByText('3')).toBeInTheDocument()
    fireEvent.click(review)
    expect(props.onOpenStagedChanges).toHaveBeenCalledTimes(1)
  })

  it('fires onExitEdit from Done (the pending-edits guard lives in the canvas wiring)', () => {
    const props = baseProps({ isDraft: true })
    renderHeader(props)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(props.onExitEdit).toHaveBeenCalledTimes(1)
  })

})

describe('ContextViewHeader — blueprint sync signal', () => {
  it('offers a retry affordance on sync error', () => {
    const props = baseProps({ syncStatus: 'error' })
    renderHeader(props)

    fireEvent.click(screen.getByRole('button', { name: /sync issue — retry/i }))
    expect(props.onRetrySync).toHaveBeenCalledTimes(1)
  })

  it('shows a labelled spinner while the layout is saving', () => {
    renderHeader(baseProps({ syncStatus: 'saving' }))
    expect(screen.getByLabelText('Saving changes')).toBeInTheDocument()
  })

  it('says nothing at rest', () => {
    renderHeader(baseProps())
    expect(screen.queryByLabelText('Saving changes')).toBeNull()
    expect(screen.queryByRole('button', { name: /sync issue/i })).toBeNull()
  })
})

describe('ContextViewHeader — the vacated title slot', () => {
  it('no longer repeats the view name, its type count, or the title menu', () => {
    // All three are the page header's now. A second, smaller copy of the name
    // is what cost this page a band it did not need.
    renderHeader(baseProps())

    expect(screen.queryByText('Data Landscape')).toBeNull()
    expect(screen.queryByText(/\d+ types?/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'View options' })).toBeNull()
    expect(screen.queryByText(/edit details/i)).toBeNull()
    expect(screen.queryByText(/^share/i)).toBeNull()
  })

  it('holds the branch switcher instead, scoped to the view', () => {
    renderHeader(baseProps({ branchWorkspaceId: 'ws_1', branchDataSourceId: 'ds_1' }))

    const switcher = screen.getByTestId('branch-switcher')
    expect(switcher.getAttribute('data-ws')).toBe('ws_1')
    expect(switcher.getAttribute('data-ds')).toBe('ds_1')
  })

  it('withholds the switcher entirely when versioning chrome is not this session\u2019s to have', () => {
    // Null is what the canvas passes when the flag is off, the session is
    // read-only, or the view has no workspace — the same three conditions that
    // stop CanvasRouter mounting the versioning bar at all.
    renderHeader(baseProps({ branchWorkspaceId: null, branchDataSourceId: 'ds_1' }))
    expect(screen.queryByTestId('branch-switcher')).toBeNull()
  })

  it('keeps the switcher in the slot on a draft too', () => {
    renderHeader(baseProps({ isDraft: true, branchWorkspaceId: 'ws_1', branchDataSourceId: 'ds_1' }))
    expect(screen.getByTestId('branch-switcher')).toBeInTheDocument()
  })
})

describe('ContextViewHeader — Trace Lineage launcher (history)', () => {
  const history = [
    { index: 0, label: 'Snowflake', mode: 'both' as const, timestamp: Date.now() - 60_000 },
  ]

  it('with no selection and no history, the button stays disabled', () => {
    renderHeader(baseProps({ canTrace: false }))
    expect(screen.getByRole('button', { name: /trace lineage/i })).toBeDisabled()
  })

  it('with no selection but history, the button is ENABLED and opens the launcher', () => {
    const props = baseProps({ canTrace: false, traceHistory: history, onResumeTraceHistory: vi.fn() })
    renderHeader(props)
    const btn = screen.getByRole('button', { name: /trace lineage/i })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    expect(screen.getByText(/pick up where you left off/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Snowflake'))
    expect(props.onResumeTraceHistory).toHaveBeenCalledWith(0)
    expect(props.onStartTrace).not.toHaveBeenCalled()
  })

  it('with a selection, the main zone traces and the chevron opens the launcher', () => {
    const props = baseProps({ canTrace: true, traceHistory: history, onResumeTraceHistory: vi.fn() })
    renderHeader(props)
    fireEvent.click(screen.getByRole('button', { name: /trace lineage/i }))
    expect(props.onStartTrace).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /trace history/i }))
    expect(screen.getByText(/pick up where you left off/i)).toBeInTheDocument()
  })
})

describe('ContextViewHeader — Focus Lens launcher', () => {
  it('with a selection, Focus Lens opens the lens on it', () => {
    const props = baseProps({ canTrace: true, onOpenLens: vi.fn() })
    renderHeader(props)
    fireEvent.click(screen.getByRole('button', { name: /focus lens/i }))
    expect(props.onOpenLens).toHaveBeenCalledTimes(1)
  })

  it('without a selection, Focus Lens is disabled with guidance', () => {
    const props = baseProps({ canTrace: false, onOpenLens: vi.fn() })
    renderHeader(props)
    const btn = screen.getByRole('button', { name: /focus lens/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringMatching(/select a single entity/i))
  })

  it('hosts that do not wire the lens see no button', () => {
    renderHeader(baseProps())
    expect(screen.queryByRole('button', { name: /focus lens/i })).toBeNull()
  })
})
