/**
 * THE DOCK, MADE HONEST about the native trace engine.
 *
 * The dock was built for `useUnifiedTrace`, where every control was a
 * parameter of the next /trace/v2 request: pick an edge type, pick a
 * hierarchy level, move a depth slider, and the trace refetches. The native
 * engine walks the whole flow to exhaustion once, so those controls now
 * describe a request that will never be made — and a control that does
 * nothing is worse than a missing one, because the reader believes it.
 *
 * So in `nativeMode` the dock drops what it cannot honour (edge-type filter,
 * hierarchy level), keeps what is real (direction, view depth), and the
 * direction arrows stop pretending to be a fetch: they flip visibility and
 * nothing else. Depth in particular must NOT ride along — the legacy arrows
 * encoded "off" as depth 0 and re-enabled a side at DEFAULT_TRACE_DEPTH,
 * which on the native engine silently rewrites the reader's view scope from
 * a control that says nothing about depth.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TraceDockControls } from '../TraceDockControls'
import { TraceDockTitleBar } from '../TraceDockTitleBar'
import { TraceDockMetricStrip } from '../TraceDockMetricStrip'
import { FULL_WALK_INITIAL_DEPTH } from '@/hooks/useLensWalk'
import type { TraceConfig, UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from '@/types/hierarchy'

const config = (over: Partial<TraceConfig> = {}): TraceConfig => ({
  upstreamDepth: 25,
  downstreamDepth: 25,
  includeColumnLineage: true,
  excludeContainmentEdges: true,
  includeInheritedLineage: true,
  autoExpandAncestors: true,
  pathOnly: false,
  autoSyncToStore: true,
  lineageEdgeTypes: [],
  level: 'auto',
  ...over,
} as TraceConfig)

function renderControls(nativeMode: boolean) {
  const onChangeConfig = vi.fn()
  const onApply = vi.fn()
  render(
    <TraceDockControls
      config={config()}
      granularityOptions={[{ id: 'dataset', name: 'Dataset', level: 2 }]}
      availableEdgeTypes={['TRANSFORMS', 'AGGREGATED']}
      resolveEdgeColor={() => '#fff'}
      onChangeConfig={onChangeConfig}
      onApply={onApply}
      nativeMode={nativeMode}
    />,
  )
  return { onChangeConfig, onApply }
}

describe('TraceDockControls — nativeMode', () => {
  it('legacy mode keeps the hierarchy-level select and the edge-type filter', () => {
    renderControls(false)
    expect(screen.getByText(/hierarchy level/i)).toBeInTheDocument()
    expect(screen.getByText(/edge types/i)).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('native mode drops both — they parameterise a fetch that never happens', () => {
    renderControls(true)
    expect(screen.queryByText(/hierarchy level/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/edge types/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    // What remains is what is real: the two view-depth sliders.
    expect(screen.getByText(/upstream depth/i)).toBeInTheDocument()
    expect(screen.getByText(/downstream depth/i)).toBeInTheDocument()
  })

  it('caps the depth sliders at the walk\u2019s own ceiling — one depth rule', () => {
    renderControls(true)
    for (const slider of screen.getAllByRole('slider')) {
      expect(Number(slider.getAttribute('max'))).toBe(FULL_WALK_INITIAL_DEPTH)
    }
  })
})

const displayMap = new Map<string, HierarchyNode>()

function traceStub(over: Partial<UseUnifiedTraceResult> = {}): UseUnifiedTraceResult {
  return {
    status: 'success',
    error: null,
    focusId: 'cfo',
    result: null,
    isTracing: true,
    isLoading: false,
    config: config(),
    setConfig: vi.fn(),
    showUpstream: true,
    showDownstream: true,
    setShowUpstream: vi.fn(),
    setShowDownstream: vi.fn(),
    retrace: vi.fn(async () => {}),
    upstreamCount: 4,
    downstreamCount: 2,
    statistics: { totalNodes: 6, totalEdges: 5, upstreamCount: 4, downstreamCount: 2 },
    drilldowns: new Map(),
    traceHistory: [],
    jumpToHistoryEntry: vi.fn(async () => {}),
    clearTraceHistory: vi.fn(),
    collapseDrilldown: vi.fn(),
    ...over,
  } as unknown as UseUnifiedTraceResult
}

function renderTitleBar(nativeMode: boolean, over: Partial<UseUnifiedTraceResult> = {}) {
  const trace = traceStub(over)
  render(
    <TraceDockTitleBar
      trace={trace}
      displayMap={displayMap}
      expanded={false}
      onToggleExpanded={vi.fn()}
      onExit={vi.fn()}
      nativeMode={nativeMode}
    />,
  )
  return trace
}

describe('TraceDockTitleBar — the direction arrows in nativeMode', () => {
  it('flips visibility ONLY — no depth rewrite, no refetch', () => {
    const trace = renderTitleBar(true)
    fireEvent.click(screen.getByRole('radio', { name: /upstream only/i }))

    expect(trace.setShowUpstream).toHaveBeenCalledWith(true)
    expect(trace.setShowDownstream).toHaveBeenCalledWith(false)
    // The whole point: direction is not a depth, and it is not a fetch.
    expect(trace.setConfig).not.toHaveBeenCalled()
    expect(trace.retrace).not.toHaveBeenCalled()
  })

  it('legacy mode still encodes direction as depth and re-traces', () => {
    const trace = renderTitleBar(false)
    fireEvent.click(screen.getByRole('radio', { name: /downstream only/i }))

    expect(trace.setConfig).toHaveBeenCalledWith({ upstreamDepth: 0, downstreamDepth: 25 })
    expect(trace.retrace).toHaveBeenCalled()
  })
})

/**
 * OUTSIDE VIEW (F7). A chain whose top has nowhere to go in this view is
 * never invented into a synthetic lane — the view model counts it and moves
 * on. That count is the only honest answer to "why is this trace smaller
 * than I expected", so the dock has to say it out loud.
 */
describe('TraceDockMetricStrip — sources outside this view', () => {
  const strip = (outsideView: number) => render(
    <TraceDockMetricStrip
      result={null}
      focusNode={null}
      totalNodes={6}
      totalEdges={5}
      upstreamCount={4}
      downstreamCount={2}
      outsideView={outsideView}
      resolveEdgeColor={() => '#fff'}
    />,
  )

  it('names the count when the view cannot place a chain', () => {
    strip(3)
    expect(screen.getByText(/3 sources outside this view/i)).toBeInTheDocument()
  })

  it('says nothing when every chain landed', () => {
    strip(0)
    expect(screen.queryByText(/outside this view/i)).not.toBeInTheDocument()
  })

  it('reads as one source in the singular', () => {
    const { container } = strip(1)
    expect(within(container).getByText(/1 source outside this view/i)).toBeInTheDocument()
  })
})
