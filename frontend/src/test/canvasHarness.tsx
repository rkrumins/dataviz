/**
 * canvasHarness — mounts the REAL `ContextViewCanvas` against a stubbed
 * provider and drives a trace the way a reader does: select an entity, press
 * Trace Lineage, read what is on screen.
 *
 * WHY THE REAL CANVAS. The trace overlay's whole claim is about what the
 * canvas does — the cards it draws, the wires between them, and above all the
 * store it must NOT write to. A harness built out of the overlay's own pieces
 * could only ever agree with itself; this one can be wrong, which is what
 * makes it a gate. The Stage 1 rebuild's invariant is `storeWrites() === 0`,
 * and only the real canvas can break it.
 *
 * WHAT IT TAKES TO MOUNT IT IN JSDOM (all of it test-only, none of it
 * mocking the canvas itself):
 *  • `IntersectionObserver` — the flow overlay observes edge visibility.
 *  • Element metrics. `LayerColumn` virtualises its rows with
 *    `@tanstack/react-virtual`, which sizes its window from the scroll
 *    element's `offsetHeight` and measures rows with `getBoundingClientRect`.
 *    jsdom reports 0 for both, so the virtualizer renders ZERO rows and the
 *    canvas looks empty while being perfectly healthy. Stubbing the two is
 *    what makes cards exist to be asserted on.
 *
 * THE SPY. `storeWrites()` counts every change to `useCanvasStore`'s `nodes`
 * or `edges` identity FROM THE MOMENT THE TRACE STARTS. Browse hydration
 * happens before that and is excluded by construction — resetting any later
 * would exclude the trace's own merge, which is precisely the thing being
 * gated, and the assertion could then never fail.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { ContextViewCanvas } from '@/components/canvas/context-view/ContextViewCanvas'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePreferencesStore } from '@/store/preferences'
import type { GraphDataProvider, GraphNode, TraceV2Result, LensClosureExtras } from '@/providers/GraphDataProvider'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

/** What `src/test/fixtures/traceEstates.ts` hands back. */
export interface TraceEstate {
  model: LensWalkModel
  layers: ViewLayerConfig[]
  assignments: Record<string, { layerId: string }>
}

export interface TraceCanvasHarness {
  /** Select `urn` and press Trace Lineage, then wait for the walk to land. */
  startTrace(urn: string): Promise<void>
  /** The card rows the canvas is currently drawing, by entity id. */
  visibleCardIds(): string[]
  /** Does this card offer a chevron (i.e. the graph says it has children)? */
  chevron(id: string): boolean
  /** The lineage lines on screen, as drawn. */
  wires(): Array<{ source: string; target: string }>
  /** Writes to the canvas store's `nodes`/`edges` since the trace started. */
  storeWrites(): number
  snapshotStore(): { nodes: string[]; edges: string[] }
  pressEscape(): void
  isTracing(): boolean
  /** Let every pending promise and effect settle. */
  settle(): Promise<void>
}

const CARD_ID_PREFIX = 'layer-node-'

/** The canvas store outlives any one mount, so a previous harness's spy would
 *  keep counting into a dead tally. One live spy at a time. */
let releaseSpy: (() => void) | null = null

/** jsdom reports no geometry; the virtualizer and the flow overlay both need
 *  some. Idempotent — several harnesses may mount in one file. */
function installJsdomLayout(): void {
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver
  }
  const el = HTMLElement.prototype as unknown as Record<string, unknown>
  if (!el.__harnessMetrics) {
    Object.defineProperty(HTMLElement.prototype, '__harnessMetrics', { value: true })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 900 })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 420 })
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 0, y: 0, top: 0, left: 0, right: 420, bottom: 40, width: 420, height: 40, toJSON: () => ({}) } as DOMRect
    }
  }
}

/** The estate's entities in the BACKEND's shape — the one the canvas's own
 *  mappers consume, so `childCount` reaches `data.childCount` (and the
 *  chevron) exactly as it does in the app. */
function wireNodes(estate: TraceEstate): GraphNode[] {
  return estate.model.nodes.map(n => ({
    urn: n.urn,
    displayName: n.displayName ?? n.urn,
    entityType: n.entityType ?? '',
    childCount: (n.data as { childCount?: number }).childCount ?? 0,
    properties: {},
  }) as unknown as GraphNode)
}

/** The estate model, back in the wire shape `toLensClosure` consumes — ONE
 *  response, no frontier, so the walk is complete the moment it lands. */
function closureFor(estate: TraceEstate, focusUrn: string): TraceV2Result & LensClosureExtras {
  return {
    focus: { urn: focusUrn, level: 0, entityType: '' },
    nodes: wireNodes(estate),
    edges: estate.model.lineageEdges.map(e => ({
      id: e.id ?? `${e.sourceUrn}>${e.targetUrn}`,
      sourceUrn: e.sourceUrn,
      targetUrn: e.targetUrn,
      edgeType: e.edgeType,
      properties: e.weight === null || e.weight === undefined ? {} : { weight: e.weight },
    })),
    containmentEdges: estate.model.containmentEdges,
    upstreamUrns: new Set(estate.model.upstreamUrns),
    downstreamUrns: new Set(estate.model.downstreamUrns),
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
  } as unknown as TraceV2Result & LensClosureExtras
}

/** The network. `traceClosure` answers the whole estate in one response;
 *  everything else the canvas may reach for answers empty rather than
 *  throwing, so a stray read can never masquerade as a trace failure. */
function stubProvider(estate: TraceEstate, focusUrn: string): GraphDataProvider {
  const closure = closureFor(estate, focusUrn)
  return {
    scopeKey: 'harness',
    traceClosure: async () => closure,
    getChildren: async () => ({ nodes: [], edges: [], totalCount: 0 }),
    getNodes: async () => wireNodes(estate),
    getEdges: async () => [],
    computeLayerAssignments: async () => ({ assignments: [], unassigned: [] }),
  } as unknown as GraphDataProvider
}

/** The browse canvas behind the trace: the estate's entities and their
 *  containment, and NO lineage — every wire on screen must have come from
 *  the trace. */
function seedBrowse(estate: TraceEstate): void {
  const nodes: LineageNode[] = wireNodes(estate).map(n => toCanvasNode(n))
  const edges: LineageEdge[] = estate.model.containmentEdges.map(c => ({
    id: `c:${c.sourceUrn}>${c.targetUrn}`,
    source: c.sourceUrn,
    target: c.targetUrn,
    type: 'lineage',
    data: { edgeType: 'CONTAINS', relationship: 'CONTAINS' },
  }) as unknown as LineageEdge)
  const store = useCanvasStore.getState()
  store.setGraph(nodes, edges)
  store.setHydrationPhase('complete')
  store.clearSelection()
}

function seedView(estate: TraceEstate): void {
  useSchemaStore.setState({
    activeViewId: 'harness-view',
    schema: {
      id: 'harness', name: 'harness', version: '1',
      entityTypes: [], relationshipTypes: [], globalVisuals: {},
      containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS', 'AGGREGATED'],
      rootEntityTypes: [], defaultViewId: 'harness-view',
      views: [{
        id: 'harness-view', name: 'Harness View',
        content: {
          visibleEntityTypes: [], visibleRelationshipTypes: [],
          defaultDepth: 3, maxDepth: 10, rootEntityTypes: [], entityScope: 'curated',
        },
        layout: {
          type: 'reference',
          referenceLayout: { layers: estate.layers, assignments: estate.assignments },
        },
        filters: {}, entityOverrides: {}, isDefault: true,
      }],
    },
  } as never)
}

export async function renderCanvasWithTrace(
  estate: TraceEstate,
  opts: { focus: string },
): Promise<TraceCanvasHarness> {
  installJsdomLayout()
  usePreferencesStore.setState({ canvasDensity: 'spacious' } as never)
  seedBrowse(estate)
  seedView(estate)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ProviderOverride value={{
        provider: stubProvider(estate, opts.focus),
        isLoading: false, error: null, scopeKind: 'ready',
        workspaceId: 'harness-ws', dataSourceId: null,
        providerReady: true, providerVersion: 1,
      } as never}>
        <ContextViewCanvas />
      </ProviderOverride>
    </QueryClientProvider>,
  )

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
  }

  const writes = { count: 0 }
  releaseSpy?.()
  releaseSpy = useCanvasStore.subscribe((s, prev) => {
    if (s.nodes !== prev.nodes || s.edges !== prev.edges) writes.count += 1
  })

  // Queried off the DOCUMENT, not the render container: the canvas mounts
  // parts of itself (the flow overlay among them) outside the container RTL
  // hands back, and a container-scoped query reads those as absent — a wire
  // that IS on screen looking like a wire that was never drawn.
  const rows = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(`[id^="${CARD_ID_PREFIX}"]`)]
  const isTracing = (): boolean => !!document.querySelector('[data-trace-active="true"]')

  // The canvas is only ready to be read once the browse hydration has drawn
  // its first cards — asserting before that reads an empty canvas as a
  // failed trace.
  await waitFor(() => {
    if (rows().length === 0) throw new Error('canvas drew no cards')
  }, { timeout: 4000 })
  await settle()

  return {
    settle,
    isTracing,
    async startTrace(urn: string) {
      act(() => { useCanvasStore.getState().selectNode(urn) })
      await settle()
      const button = await screen.findByRole('button', { name: /trace lineage/i })
      // From here on, every store write belongs to the trace.
      writes.count = 0
      await act(async () => { fireEvent.click(button) })
      await waitFor(() => {
        if (!isTracing()) throw new Error('the canvas did not enter trace mode')
      }, { timeout: 4000 })
      await settle()
    },
    visibleCardIds: () => rows().map(row => row.id.slice(CARD_ID_PREFIX.length)),
    chevron: (id: string) => {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      const toggle = row?.querySelector('button')
      // The toggle is always in the DOM; a card with nothing inside it
      // renders it inert (`pointer-events-none`) rather than removing it.
      return !!toggle && !toggle.className.includes('pointer-events-none')
    },
    wires: () => [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')].map(g => ({
      source: g.getAttribute('data-edge-src') ?? '',
      target: g.getAttribute('data-edge-tgt') ?? '',
    })),
    storeWrites: () => writes.count,
    snapshotStore: () => {
      const s = useCanvasStore.getState()
      return { nodes: s.nodes.map(n => n.id).sort(), edges: s.edges.map(e => e.id).sort() }
    },
    pressEscape: () => {
      act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    },
  }
}
