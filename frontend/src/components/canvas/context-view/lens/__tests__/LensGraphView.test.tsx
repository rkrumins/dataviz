/**
 * LensGraphView — React Flow smoke tests in jsdom.
 *
 * The layout math is covered in buildLensLayout.test.ts; these prove
 * the component renders real sessions and that each gesture dispatches
 * the right session action: pill → expandLineage, chevron →
 * openChildren, banner retry → retryExpansion, double-click → onFocus.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { GraphEdge, GraphNode, TraceV2Result } from '@/providers/GraphDataProvider'
import { useSchemaStore } from '@/store/schema'
import {
  createLensSession,
  expansionKeyOf,
  failExpansion,
  mergeAncestors,
  mergeExpansion,
  mergeNodes,
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
    expect(screen.getByText('Customer Portal')).toBeInTheDocument()
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
