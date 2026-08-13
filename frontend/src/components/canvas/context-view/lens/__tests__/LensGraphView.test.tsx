/**
 * LensGraphView — React Flow smoke tests in jsdom.
 *
 * The layout math is covered in buildLensLayout.test.ts; these prove
 * the component renders real sessions and that each gesture dispatches
 * the right session action: pill → expandLineage, chevron →
 * openChildren, banner retry → retryExpansion, double-click → onFocus.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GraphEdge, GraphNode, TraceV2Result } from '@/providers/GraphDataProvider'
import { useSchemaStore } from '@/store/schema'
import {
  createLensSession,
  expansionKeyOf,
  failExpansion,
  mergeAncestors,
  mergeChildren,
  mergeDrill,
  mergeExpansion,
  mergeNodes,
  startDrill,
  type LensSessionState,
} from '../lensGraph'
import type { LensSessionApi } from '../useLensSession'
import { LensGraphView } from '../LensGraphView'

const OPTS = { containmentEdgeTypes: ['CONTAINS'] }

let seq = 0
const edge = (s: string, t: string, edgeType = 'CONSUMES', properties?: Record<string, unknown>): GraphEdge =>
  ({ id: `e${seq++}`, sourceUrn: s, targetUrn: t, edgeType, properties })
const node = (urn: string, entityType: string, displayName: string): GraphNode =>
  ({ urn, entityType, displayName, properties: {} })

const trace = (overrides: Partial<TraceV2Result> = {}): TraceV2Result => ({
  nodes: [],
  edges: [],
  containmentEdges: [],
  upstreamUrns: new Set<string>(),
  downstreamUrns: new Set<string>(),
  focus: { urn: 'app', level: 1, entityType: 'app' },
  effectiveLevel: 1,
  isInherited: false,
  inheritedFromUrn: null,
  truncated: false,
  truncationReason: null,
  ...overrides,
})

function appSession(): LensSessionState {
  let s = createLensSession('app')
  s = mergeNodes(s, [
    node('app', 'app', 'Customer Portal'),
    node('gold.orders', 'dataset', 'Gold Orders'),
  ])
  s = mergeExpansion(
    s,
    expansionKeyOf('down', 'app'),
    'app',
    { rawEdges: [edge('app', 'gold.orders')], rawTruncated: false, trace: trace() },
    OPTS,
  )
  s = mergeExpansion(s, expansionKeyOf('up', 'app'), 'app', { rawEdges: [], rawTruncated: false, trace: trace() }, OPTS)
  s = mergeAncestors(s, 'app', [node('domain', 'domain', 'Retail Domain')])
  return s
}

function api(state: LensSessionState): LensSessionApi & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    expandLineage: vi.fn(),
    openChildren: vi.fn(),
    loadMoreChildren: vi.fn(),
    connectedExpand: vi.fn(async () => ({ records: 1, capped: false })),
    drillRollup: vi.fn(),
    retryExpansion: vi.fn(),
    retryChildren: vi.fn(),
  }
  return { state, ...calls, calls }
}

beforeEach(() => {
  useSchemaStore.setState({
    schema: {
      containmentEdgeTypes: ['CONTAINS'],
      lineageEdgeTypes: ['CONSUMES', 'FLOWS_TO'],
      entityTypes: [],
      relationshipTypes: [
        { id: 'CONSUMES', name: 'Consumes' },
      ],
    },
  } as never)
})

describe('LensGraphView', () => {
  it('renders the focal, its partner, the breadcrumb and honest whispers', () => {
    const session = api(appSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    // Named on the focal card AND in the identity header block.
    expect(screen.getAllByText('Customer Portal').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Gold Orders')).toBeInTheDocument()
    // Breadcrumb names the focal's ancestor, clickable.
    expect(screen.getByTitle('Focus Retail Domain')).toBeInTheDocument()
    // Upstream side is honestly empty (expansion done, nothing there).
    expect(screen.getByText('No upstream lineage in the data source')).toBeInTheDocument()
    // Edge rendering itself needs measured nodes (real layout) — jsdom
    // never measures, so edge labels are asserted by the harness
    // screenshots and the builder tests, not here.
  })

  it('dispatches expandLineage from a partner pill', () => {
    const session = api(appSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Expand downstream lineage of gold.orders'))
    expect(session.calls.expandLineage).toHaveBeenCalledWith('down', 'gold.orders')
  })

  it('dispatches openChildren from an unopened chevron', () => {
    const session = api(appSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Open contents of gold.orders'))
    expect(session.calls.openChildren).toHaveBeenCalledWith('gold.orders')
  })

  it('re-centers on double-click and from the detail strip', () => {
    const onFocus = vi.fn()
    const session = api(appSession())
    render(<LensGraphView session={session} onFocus={onFocus} />)
    const partner = screen.getByText('Gold Orders')
    fireEvent.doubleClick(partner)
    expect(onFocus).toHaveBeenCalledWith('gold.orders')

    fireEvent.click(partner)
    fireEvent.click(screen.getByText('Focus here'))
    expect(onFocus).toHaveBeenCalledTimes(2)
  })

  it('surfaces an inherited banner with a focus shortcut', () => {
    let s = createLensSession('emptyContainer')
    s = mergeNodes(s, [
      node('emptyContainer', 'schema', 'Empty Schema'),
      node('parentDb', 'container', 'Parent DB'),
    ])
    s = mergeExpansion(
      s,
      expansionKeyOf('down', 'emptyContainer'),
      'emptyContainer',
      {
        rawEdges: [],
        rawTruncated: false,
        trace: trace({ isInherited: true, inheritedFromUrn: 'parentDb' }),
      },
      OPTS,
    )
    const onFocus = vi.fn()
    render(<LensGraphView session={api(s)} onFocus={onFocus} />)
    expect(screen.getByText(/nearest ancestor with lineage/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Focus it'))
    expect(onFocus).toHaveBeenCalledWith('parentDb')
  })

  it('surfaces truncation and offers retry on a failed expansion', () => {
    let s = appSession()
    s = mergeExpansion(
      s,
      expansionKeyOf('down', 'gold.orders'),
      'gold.orders',
      { rawEdges: [], rawTruncated: true, trace: null },
      OPTS,
    )
    s = failExpansion(s, expansionKeyOf('up', 'gold.orders'))
    const session = api(s)
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    expect(screen.getByText(/Partial picture/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Retry'))
    expect(session.calls.retryExpansion).toHaveBeenCalledWith('up', 'gold.orders')
  })
})

// ── Connected expand routing ──────────────────────────────────────────

/** Focal domain —AGG→ Domain B (undrilled rollup partner). */
function domainSession(): LensSessionState {
  let s = createLensSession('domainA')
  s = mergeNodes(s, [
    node('domainA', 'domain', 'Domain A'),
    node('domainB', 'domain', 'Domain B'),
  ])
  s = mergeExpansion(
    s,
    expansionKeyOf('down', 'domainA'),
    'domainA',
    {
      rawEdges: [],
      rawTruncated: false,
      trace: trace({
        edges: [edge('domainA', 'domainB', 'AGGREGATED', { weight: 7, sourceEdgeTypes: ['CONSUMES'] })],
        nodes: [node('domainB', 'domain', 'Domain B')],
      }),
    },
    OPTS,
  )
  s = mergeExpansion(s, expansionKeyOf('up', 'domainA'), 'domainA', { rawEdges: [], rawTruncated: false, trace: trace() }, OPTS)
  return s
}

/** The same, drilled at B into App1/App2 (connected) — plus B's full
 *  children page carrying the unconnected App3. */
function drilledDomainSession(): LensSessionState {
  let s = domainSession()
  const rollup = [...s.records.values()].find(r => r.aggregated)!
  s = startDrill(s, rollup.id, 'domainB')
  s = mergeDrill(s, rollup.id, trace({
    nodes: [node('App1', 'app', 'App One'), node('App2', 'app', 'App Two')],
    containmentEdges: [edge('domainB', 'App1', 'CONTAINS'), edge('domainB', 'App2', 'CONTAINS')],
    edges: [
      edge('domainA', 'App1', 'AGGREGATED', { weight: 3 }),
      edge('domainA', 'App2', 'AGGREGATED', { weight: 4 }),
    ],
  }), OPTS, 'domainB')
  s = mergeChildren(s, 'domainB', {
    children: [node('App1', 'app', 'App One'), node('App2', 'app', 'App Two'), node('App3', 'app', 'App Three')],
    containmentEdges: [
      edge('domainB', 'App1', 'CONTAINS'),
      edge('domainB', 'App2', 'CONTAINS'),
      edge('domainB', 'App3', 'CONTAINS'),
    ],
    lineageEdges: [],
    totalChildren: 3,
    hasMore: false,
    nextCursor: null,
  }, OPTS)
  return s
}

describe('connected expand routing', () => {
  it('routes the chevron on a rollup partner to connectedExpand, not openChildren', () => {
    const session = api(domainSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Open contents of domainB'))
    expect(session.calls.connectedExpand).toHaveBeenCalledWith('domainB')
    expect(session.calls.openChildren).not.toHaveBeenCalled()
  })

  it('the focal always opens plain contents — never consumes partner rollups', () => {
    const session = api(domainSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    // domainA has a drillable incident rollup (A→B), but expanding the
    // focal must not drill it anchored at the wrong end.
    fireEvent.click(screen.getByLabelText('Open contents of domainA'))
    expect(session.calls.openChildren).toHaveBeenCalledWith('domainA')
    expect(session.calls.connectedExpand).not.toHaveBeenCalled()
  })

  it('falls back to a plain contents open when nothing per-child is mapped', async () => {
    const session = api(domainSession())
    session.calls.connectedExpand.mockResolvedValue({ records: 0, capped: false })
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Open contents of domainB'))
    await waitFor(() => expect(session.calls.openChildren).toHaveBeenCalledWith('domainB'))
  })

  it('folds an opened connected frame instead of re-firing anything', () => {
    const session = api(drilledDomainSession())
    render(<LensGraphView session={session} onFocus={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Open contents of domainB'))
    expect(session.calls.connectedExpand).not.toHaveBeenCalled()
    expect(session.calls.openChildren).not.toHaveBeenCalled()
  })

  it('quiets unconnected members in all mode and toggles modes from the strip', () => {
    const session = api(drilledDomainSession())
    const { container } = render(<LensGraphView session={session} onFocus={vi.fn()} />)
    // Default (no view gesture yet): all mode — App3 present but quiet.
    expect(container.querySelector('[data-lens-card="App3"][data-lens-quiet]')).not.toBeNull()
    expect(container.querySelector('[data-lens-card="App1"][data-lens-quiet]')).toBeNull()
    expect(screen.getByText('3 inside · 2 connected')).toBeInTheDocument()
    // Strip toggle → connected only: App3 leaves the board.
    fireEvent.click(screen.getByText('Connected only'))
    expect(container.querySelector('[data-lens-card="App3"]')).toBeNull()
    expect(screen.getByText('2 connected')).toBeInTheDocument()
    // Children are already loaded, so toggling back fetches nothing.
    fireEvent.click(screen.getByText(/^Show all/))
    expect(session.calls.openChildren).not.toHaveBeenCalled()
    expect(container.querySelector('[data-lens-card="App3"]')).not.toBeNull()
  })

  it('Show all fetches children once when they were never loaded', () => {
    const s = (() => {
      let st = domainSession()
      const rollup = [...st.records.values()].find(r => r.aggregated)!
      st = startDrill(st, rollup.id, 'domainB')
      st = mergeDrill(st, rollup.id, trace({
        nodes: [node('App1', 'app', 'App One')],
        containmentEdges: [edge('domainB', 'App1', 'CONTAINS')],
        edges: [edge('domainA', 'App1', 'AGGREGATED', { weight: 3 })],
      }), OPTS, 'domainB')
      return st
    })()
    const session = api(s)
    render(
      <LensGraphView
        session={session}
        onFocus={vi.fn()}
        initialConnectedFrames={new Set(['domainB'])}
      />,
    )
    // Seeded connected mode: the strip offers Show all.
    fireEvent.click(screen.getByText(/^Show all/))
    expect(session.calls.openChildren).toHaveBeenCalledTimes(1)
    expect(session.calls.openChildren).toHaveBeenCalledWith('domainB')
  })
})
