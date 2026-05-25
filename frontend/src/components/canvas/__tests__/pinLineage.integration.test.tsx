/**
 * Pin Lineage — UI integration tests.
 *
 * Algorithm correctness lives in usePinnedLineagePath.test.ts. These tests
 * cover the user-facing contracts of the two surfaces that expose pin
 * controls today: TraceToolbar (GraphCanvas + HierarchyCanvas) and the
 * PinDockStrip inside TraceBottomDock (ContextViewCanvas). Both render the
 * same chip + Isolate/Dim toggle + Clear shape, so a single source of
 * truth here catches regressions in either surface.
 *
 * Heavy children (ELK, ReactFlow) are deliberately out of scope — those
 * are covered by the canvas-level smoke tests, and exercising them here
 * would force test-only mocks of the entire layout pipeline.
 */

import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TraceToolbar } from '../TraceToolbar'
import { TraceBottomDock } from '../trace/TraceBottomDock'
import type { TraceConfig, UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from '@/types/hierarchy'

// framer-motion stubs — same passthrough pattern used elsewhere so
// AnimatePresence-wrapped trees render synchronously and chips/buttons
// land in the DOM immediately.
vi.mock('framer-motion', () => {
  const cache = new Map<string, React.ComponentType<unknown>>()
  const passthrough = (tag: string) => {
    let cmp = cache.get(tag)
    if (!cmp) {
      cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
        function MotionStub(props, ref) {
          return React.createElement(tag, { ...props, ref })
        },
      ) as unknown as React.ComponentType<unknown>
      cache.set(tag, cmp)
    }
    return cmp
  }
  const motion = new Proxy({}, { get: (_t, tag: string) => passthrough(tag) })
  // useSpring is consumed by TraceDockTitleBar's count-up animation; stub
  // it as a plain value carrier so the dock can mount under tests.
  const useSpring = (initial: number) => ({
    get: () => initial,
    set: () => {},
    on: () => () => {},
  })
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSpring,
    LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

// The dock embeds a large title bar with its own animations, recent menu,
// and direction radio group — none of it relevant to the pin strip we want
// to test. Replace it with a no-op so the strip is exercised in isolation
// without the whole trace UI tree mounting.
vi.mock('../trace/TraceDockTitleBar', () => ({
  TraceDockTitleBar: () => <div data-testid="title-bar-stub" />,
}))
vi.mock('../trace/TraceDockBreadcrumb', () => ({
  TraceDockBreadcrumb: () => null,
}))

const baseConfig: TraceConfig = {
  upstreamDepth: 3,
  downstreamDepth: 3,
  includeColumnLineage: false,
  excludeContainmentEdges: true,
  includeInheritedLineage: false,
  autoExpandAncestors: true,
  pathOnly: false,
  autoSyncToStore: true,
}

function renderToolbar(extra: Partial<React.ComponentProps<typeof TraceToolbar>> = {}) {
  return render(
    <TraceToolbar
      focusNodeName="FocusTable"
      upstreamCount={0}
      downstreamCount={0}
      showUpstream={true}
      showDownstream={true}
      onToggleUpstream={() => {}}
      onToggleDownstream={() => {}}
      onExitTrace={() => {}}
      config={baseConfig}
      onConfigChange={() => {}}
      {...extra}
    />
  )
}

describe('TraceToolbar — Pin Lineage section', () => {
  it('hides the pin section when no pins are set', () => {
    renderToolbar({ pinnedCount: 0 })
    expect(screen.queryByText(/pinned/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /isolate/i })).toBeNull()
  })

  it('renders pin chips with per-chip unpin buttons', async () => {
    const onUnpinTarget = vi.fn()
    renderToolbar({
      pinnedCount: 2,
      pinnedTargets: [
        { urn: 'urn:a', label: 'ReportA' },
        { urn: 'urn:b', label: 'ReportB' },
      ],
      onUnpinTarget,
    })

    expect(screen.getByText('ReportA')).toBeInTheDocument()
    expect(screen.getByText('ReportB')).toBeInTheDocument()

    // Each chip has its own Unpin button.
    const unpinButtons = screen.getAllByTitle('Unpin')
    expect(unpinButtons).toHaveLength(2)

    await userEvent.click(unpinButtons[0])
    expect(onUnpinTarget).toHaveBeenCalledTimes(1)
    expect(onUnpinTarget).toHaveBeenCalledWith('urn:a')
  })

  it('flags unreachable pins and shows the summary warning', () => {
    renderToolbar({
      pinnedCount: 2,
      pinnedTargets: [
        { urn: 'urn:a', label: 'ReportA' },
        { urn: 'urn:b', label: 'ReportB' },
      ],
      unreachablePinUrns: new Set(['urn:b']),
    })

    // Per-pin warning is encoded as the chip's title attribute so screen
    // readers + hover tooltip both surface the cause.
    const orphanedChip = screen.getByTitle(/ReportB\s*·\s*unreachable from focus/i)
    expect(orphanedChip).toBeInTheDocument()

    // Summary warning aggregates the count.
    expect(screen.getByText(/1 unreachable/i)).toBeInTheDocument()
  })

  it('Isolate/Dim toggle calls onSetPinDisplayMode', async () => {
    const onSetPinDisplayMode = vi.fn()
    renderToolbar({
      pinnedCount: 1,
      pinnedTargets: [{ urn: 'urn:a', label: 'ReportA' }],
      pinDisplayMode: 'hide',
      onSetPinDisplayMode,
    })

    await userEvent.click(screen.getByRole('button', { name: /^dim$/i }))
    expect(onSetPinDisplayMode).toHaveBeenCalledWith('dim')

    await userEvent.click(screen.getByRole('button', { name: /^isolate$/i }))
    expect(onSetPinDisplayMode).toHaveBeenCalledWith('hide')
  })

  it('clear-pins button calls onClearPins', async () => {
    const onClearPins = vi.fn()
    renderToolbar({
      pinnedCount: 1,
      pinnedTargets: [{ urn: 'urn:a', label: 'ReportA' }],
      onClearPins,
    })

    await userEvent.click(screen.getByTitle(/clear all pins/i))
    expect(onClearPins).toHaveBeenCalledTimes(1)
  })

  it('falls back to the bare count when no pinnedTargets are provided', () => {
    renderToolbar({ pinnedCount: 3 })
    // No chip list, no × buttons — just the legacy count chip.
    expect(screen.getByText(/3 pinned/i)).toBeInTheDocument()
    expect(screen.queryByTitle('Unpin')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TraceBottomDock — PinDockStrip (ContextView's pin surface)
// ---------------------------------------------------------------------------

function stubTrace(): UseUnifiedTraceResult {
  // Cast through unknown — only the fields the dock actually reads matter
  // for this strip-focused test, and stubbing the whole interface would
  // dwarf the assertions.
  return {
    focusId: 'urn:focus',
    isTracing: true,
    showUpstream: true,
    showDownstream: true,
    upstreamCount: 0,
    downstreamCount: 0,
    config: baseConfig,
    setConfig: () => {},
    drilldowns: new Map(),
    traceHistory: [],
    result: null,
    statistics: undefined,
    isLoading: false,
    retrace: () => {},
    setShowUpstream: () => {},
    setShowDownstream: () => {},
    collapseDrilldown: () => {},
  } as unknown as UseUnifiedTraceResult
}

function renderDock(extra: Partial<React.ComponentProps<typeof TraceBottomDock>> = {}) {
  return render(
    <TraceBottomDock
      trace={stubTrace()}
      displayMap={new Map<string, HierarchyNode>()}
      availableEdgeTypes={[]}
      granularityOptions={[]}
      resolveEdgeColor={() => '#888'}
      expanded={false}
      onToggleExpanded={() => {}}
      onExit={() => {}}
      onJumpToUrn={() => {}}
      {...extra}
    />
  )
}

describe('TraceBottomDock — PinDockStrip', () => {
  it('hides the strip when no pins exist', () => {
    renderDock({ pinnedTargets: [] })
    expect(screen.queryByRole('button', { name: /^isolate$/i })).toBeNull()
  })

  it('shows pin chips, mode toggle, and clear', async () => {
    const onUnpinTarget = vi.fn()
    const onSetPinDisplayMode = vi.fn()
    const onClearPins = vi.fn()
    renderDock({
      pinnedTargets: [{ urn: 'urn:a', label: 'ReportA' }],
      unreachablePinUrns: new Set(),
      onUnpinTarget,
      pinDisplayMode: 'hide',
      onSetPinDisplayMode,
      onClearPins,
    })

    expect(screen.getByText('ReportA')).toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Unpin'))
    expect(onUnpinTarget).toHaveBeenCalledWith('urn:a')

    await userEvent.click(screen.getByRole('button', { name: /^dim$/i }))
    expect(onSetPinDisplayMode).toHaveBeenCalledWith('dim')

    await userEvent.click(screen.getByTitle(/clear all pins/i))
    expect(onClearPins).toHaveBeenCalledTimes(1)
  })

  it('surfaces unreachable pins in the strip', () => {
    renderDock({
      pinnedTargets: [
        { urn: 'urn:a', label: 'ReportA' },
        { urn: 'urn:b', label: 'OrphanedPin' },
      ],
      unreachablePinUrns: new Set(['urn:b']),
    })

    // PinDockStrip uses the richer "{label} · unreachable from focus" title;
    // the aggregate "N unreachable" chip still surfaces the count.
    expect(screen.getByTitle(/OrphanedPin\s*·\s*unreachable from focus/i)).toBeInTheDocument()
    expect(screen.getByText(/1 unreachable/i)).toBeInTheDocument()
  })
})
