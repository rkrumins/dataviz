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
 * or `edges` identity FROM THE MOMENT THE TRACE STARTS. Only those two: a
 * trace legitimately writes `visibleEdges` (the "what is on screen" mirror
 * the entity drawer reads) and selection/drawer state. What exiting a trace
 * has to restore is the GRAPH, and that is `nodes`/`edges`. Browse hydration
 * happens before that and is excluded by construction — resetting any later
 * would exclude the trace's own merge, which is precisely the thing being
 * gated, and the assertion could then never fail.
 *
 * NOTHING IS ALLOWED TO FAIL QUIETLY. The canvas catches and logs a great
 * deal — a malformed provider answer, a view re-fetch that never resolves —
 * and every one of those leaves the canvas running in a degraded state that
 * looks exactly like a healthy one. A stub that returned the wrong shape once
 * parked the assignment store at `error` with empty assignments, and the only
 * trace of it was a line on stderr. So the harness records every
 * `console.error` and THROWS on the next checkpoint (end of mount, end of
 * `startTrace`). A stub that drifts from the real contract fails loudly.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { ContextViewCanvas } from '@/components/canvas/context-view/ContextViewCanvas'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePreferencesStore } from '@/store/preferences'
import { useBranchStore } from '@/store/branchStore'
import { useFeaturesStore } from '@/store/features'
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
  /** Select `urn` and press Trace Lineage, then wait for the walk to land.
   *  With `deferTrace`, returns as soon as the session is open — the closure
   *  is still pending until `resolveTrace()`. */
  startTrace(urn: string): Promise<void>
  /** `deferTrace` only: let the pending `traceClosure` resolve, then settle.
   *  Lets a test look at the canvas DURING the walk. */
  resolveTrace(): Promise<void>
  /** The card rows the canvas is currently drawing, by entity id. */
  visibleCardIds(): string[]
  /** Does this card offer a chevron (i.e. the graph says it has children)? */
  chevron(id: string): boolean
  /** The "+N" / "N on this lineage" pill on a card row, if it has one. */
  countPill(id: string): string | null
  /** Every layer-header count tooltip currently on screen. */
  headerTitles(): string[]
  /** Is the child-search magnifier offered on this card? */
  childSearchButton(id: string): boolean
  /** Click that magnifier, opening the column's inline search box. */
  openChildSearch(id: string): Promise<void>
  /** Type a query into an open child-search box AND SUBMIT it — the real
   *  keystroke path into the canvas's `onSearchChildren`. The box keeps its
   *  own local value and only commits on Enter/blur, so a change event alone
   *  reaches nothing. Returns false if no box is open. */
  typeChildSearch(query: string): Promise<boolean>
  /** Click a card's expand chevron. */
  toggle(id: string): Promise<void>
  /** How many closure fetches the provider has served. The number a
   *  view-only control must never move: direction, view depth and expansion
   *  are all re-projections of the walk the session already holds. */
  providerCalls(): number
  /** Click one of the dock's direction radios. */
  setDirection(dir: 'up' | 'both' | 'down'): Promise<void>
  /** Open the header's Depth chip and click a preset by label. */
  depthPreset(label: string | RegExp): Promise<void>
  /** The depth presets the control offers, as `${up}/${down}` pairs. */
  depthPresetValues(): string[]
  /** Scrub a Settings-tab depth slider and RELEASE it — the commit edge that
   *  fires the dock's "apply". Requires `openDockSettings()` first. */
  commitDockDepth(value: number): Promise<void>
  /** Click the dock's ←/→ trace-history arrows. */
  historyBack(): Promise<void>
  historyForward(): Promise<void>
  /** Expand the dock and open its Settings tab. */
  openDockSettings(): Promise<void>
  /** Wait past the expansion recorder's 250 ms trailing edge, so the current
   *  picture has actually reached the history entry. */
  flushExpansionRecord(): Promise<void>
  /** Press a bare key on the document — the canvas's global shortcuts. */
  pressKey(key: string): Promise<void>
  /** Click a card row (what the armed connect flow resolves as its target). */
  clickCard(id: string): Promise<void>
  /** Is the edge-type picker on screen? (It only appears once a connection
   *  has resolved a source AND a target — i.e. the staging flow is live.) */
  connectPickerOpen(): boolean
  /** Is the row's drag-to-connect handle rendered? */
  connectHandle(id: string): boolean
  /** The lineage lines on screen, as drawn. */
  wires(): Array<{ source: string; target: string }>
  /** Writes to the canvas store's `nodes`/`edges` since the trace started. */
  storeWrites(): number
  snapshotStore(): { nodes: string[]; edges: string[] }
  pressEscape(): void
  isTracing(): boolean
  /** Let every pending promise and effect settle. */
  settle(): Promise<void>
  /** Everything the canvas logged as an error. Checked automatically at the
   *  end of mount and of `startTrace`; exposed for diagnosis. */
  consoleErrors(): string[]
}

const CARD_ID_PREFIX = 'layer-node-'

/** The canvas store outlives any one mount, so a previous harness's spy would
 *  keep counting into a dead tally. One live spy at a time. */
let releaseSpy: (() => void) | null = null
let releaseFetch: (() => void) | null = null
let releaseConsole: (() => void) | null = null

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
    // jsdom has no scrolling; the reveal/pulse paths call these.
    Element.prototype.scrollTo = function () {}
    Element.prototype.scrollIntoView = function () {}
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
function closureFor(estate: TraceEstate, focusUrn: string, stall?: boolean): TraceV2Result & LensClosureExtras {
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
    frontierUp: stall ? [{ urn: focusUrn, totalCount: null, nextCursor: null }] : [],
    frontierDown: [], seedTruncated: false,
  } as unknown as TraceV2Result & LensClosureExtras
}

/** parent urn → child urns, from the estate's containment. */
function childrenOf(estate: TraceEstate): Map<string, string[]> {
  const kids = new Map<string, string[]>()
  for (const c of estate.model.containmentEdges) {
    kids.set(c.sourceUrn, [...(kids.get(c.sourceUrn) ?? []), c.targetUrn])
  }
  return kids
}

/** The network. `traceClosure` answers the whole estate in one response;
 *  every other read answers from the same estate, in the REAL result shape.
 *  A shape that only looks right is worse than none: `setAssignmentResult`
 *  reads `parentMap`/`edges`/`unassignedEntityIds`/`stats.computeTimeMs`, and
 *  an object missing them throws into a catch that parks the assignment store
 *  at `error` with no assignments at all — silently. */
function stubProvider(
  estate: TraceEstate,
  focusUrn: string,
  calls: { traceClosure: number },
  gate?: { promise: Promise<void> },
  stall?: boolean,
): GraphDataProvider {
  const closure = closureFor(estate, focusUrn, stall)
  const nodes = wireNodes(estate)
  const byUrn = new Map(nodes.map(n => [n.urn, n]))
  const kids = childrenOf(estate)
  const parentMap = new Map<string, string>()
  for (const c of estate.model.containmentEdges) {
    if (!parentMap.has(c.targetUrn)) parentMap.set(c.targetUrn, c.sourceUrn)
  }
  const childrenFor = (parentUrn: string): GraphNode[] =>
    (kids.get(parentUrn) ?? []).map(urn => byUrn.get(urn)).filter((n): n is GraphNode => !!n)
  const assignments = new Map(Object.entries(estate.assignments).map(([entityId, a]) => [
    entityId,
    { entityId, layerId: a.layerId, isInherited: false },
  ]))
  return {
    scopeKey: 'harness',
    traceClosure: async () => {
      calls.traceClosure += 1
      if (gate) await gate.promise
      // A STALLED WALK. The first answer reports a frontier, every frontier op
      // after it fails — which is exactly `fullWalkStatus.stalled`: candidates
      // remain, none is loading, and each one already carries its 'error'
      // marker. `runFrontierOp` swallows the rejection (no console noise), so
      // the canvas sits in the state where `continueWalk` is the ONLY thing
      // that would go back to the network.
      if (stall && calls.traceClosure > 1) throw new Error('frontier op refused (harness)')
      return closure
    },
    getChildren: async (parentUrn: string) => childrenFor(parentUrn),
    getChildrenWithEdges: async (parentUrn: string) => ({
      children: childrenFor(parentUrn),
      containmentEdges: (kids.get(parentUrn) ?? []).map(child => ({
        id: `c:${parentUrn}>${child}`, sourceUrn: parentUrn, targetUrn: child, edgeType: 'CONTAINS',
      })),
      lineageEdges: [],
      totalChildren: (kids.get(parentUrn) ?? []).length,
      hasMore: false,
      nextCursor: null,
    }),
    getParent: async (childUrn: string) => byUrn.get(parentMap.get(childUrn) ?? '') ?? null,
    getNodes: async () => nodes,
    getEdges: async () => [],
    computeLayerAssignments: async () => ({
      assignments,
      parentMap,
      edges: [],
      unassignedEntityIds: nodes.map(n => n.urn).filter(urn => !assignments.has(urn)),
      stats: { totalNodes: nodes.length, assignedNodes: assignments.size, computeTimeMs: 0 },
    }),
  } as unknown as GraphDataProvider
}

/** The HTTP surface. The canvas re-fetches its own view on mount to pick up
 *  the branch-effective layout; left to the real `fetch` that is an
 *  ERR_INVALID_URL (a relative path with no origin) swallowed into a
 *  `console.error`. Answer it with the layout the store already holds, so the
 *  effect finds nothing to change and returns. */
function stubFetch(estate: TraceEstate): () => void {
  const original = globalThis.fetch
  const view = {
    id: 'harness-view',
    config: {
      layout: { type: 'reference', referenceLayout: { layers: estate.layers, assignments: estate.assignments } },
      content: { entityScope: 'curated' },
    },
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = url.includes('/api/v1/views/') ? view : {}
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return () => { globalThis.fetch = original }
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
        id: 'harness-view', name: 'Harness View', workspaceId: 'harness-ws',
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
  opts: { focus: string; deferTrace?: boolean; draft?: boolean; stallWalk?: boolean },
): Promise<TraceCanvasHarness> {
  installJsdomLayout()
  releaseFetch?.()
  releaseFetch = stubFetch(estate)
  usePreferencesStore.setState({ canvasDensity: 'spacious' } as never)
  // AUTHORING MUST BE LIVE for a test of the trace's write gates to mean
  // anything: with no draft open (or edit mode off) every connect/edit path
  // is already inert, and the test would pass against a canvas with no gates
  // at all. `isDraft` needs the branch store scoped to this exact
  // (workspace, dataSource, view); `canEditGraph` needs the admin flag too.
  useBranchStore.setState({
    workspaceId: opts.draft ? 'harness-ws' : null,
    dataSourceId: null,
    viewId: opts.draft ? 'harness-view' : null,
    currentBranchId: opts.draft ? 'harness-branch' : null,
  } as never)
  useFeaturesStore.setState({
    values: { ...useFeaturesStore.getState().values, editModeEnabled: !!opts.draft },
  } as never)
  seedBrowse(estate)
  seedView(estate)

  // Every swallowed failure, made loud. See the file header.
  const errors: string[] = []
  releaseConsole?.()
  const realError = console.error
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map(part => (part instanceof Error ? part.message : String(part))).join(' '))
    realError(...parts)
  }
  releaseConsole = () => { console.error = realError }
  const assertQuiet = (when: string): void => {
    if (errors.length > 0) {
      throw new Error(`the canvas logged ${errors.length} error(s) during ${when}:\n  ${errors.join('\n  ')}`)
    }
  }

  // With `deferTrace` the walk hangs until the test releases it, so a test
  // can read the canvas while the closure is still in flight — the window in
  // which the reader must keep seeing BROWSE rather than a blank canvas.
  let releaseTrace: () => void = () => {}
  const gate = opts.deferTrace
    ? { promise: new Promise<void>(resolve => { releaseTrace = resolve }) }
    : undefined

  const providerCalls = { traceClosure: 0 }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ProviderOverride value={{
        provider: stubProvider(estate, opts.focus, providerCalls, gate, opts.stallWalk),
        isLoading: false, error: null, scopeKind: 'ready',
        workspaceId: 'harness-ws', dataSourceId: null,
        providerReady: true, providerVersion: 1,
      } as never}>
        <ContextViewCanvas />
      </ProviderOverride>
    </QueryClientProvider>,
  )

  // REAL TIME, for the surfaces that animate. `settle` drains microtasks and
  // frames but barely advances the clock, so anything gated on a duration —
  // an AnimatePresence exit before the next tab mounts, the canvas's 250 ms
  // expansion recorder — has not happened yet when it returns.
  const wait = async (ms: number): Promise<void> => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  }

  // Macrotasks AND animation frames. The flow overlay redraws its edges on a
  // rAF (`scheduleUpdate`), so a settle that only drains timers reads the DOM
  // before the wires are painted — `wires()` comes back empty and a trace that
  // drew nothing looks exactly like one that drew the wrong thing.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
        await new Promise(resolve => setTimeout(resolve, 0))
      })
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
  assertQuiet('mount')

  return {
    settle,
    isTracing,
    consoleErrors: () => [...errors],
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
      assertQuiet('the trace')
    },
    async resolveTrace() {
      releaseTrace()
      await settle()
      assertQuiet('resolving the trace')
    },
    visibleCardIds: () => rows().map(row => row.id.slice(CARD_ID_PREFIX.length)),
    chevron: (id: string) => {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      const toggle = row?.querySelector('button')
      // The toggle is always in the DOM; a card with nothing inside it
      // renders it inert (`pointer-events-none`) rather than removing it.
      return !!toggle && !toggle.className.includes('pointer-events-none')
    },
    countPill: (id: string) => {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      const pill = [...(row?.querySelectorAll<HTMLElement>('span') ?? [])]
        .find(el => /^\+?\d[\d,]*( on this lineage)?$/.test(el.textContent?.trim() ?? ''))
      return pill?.textContent?.trim() ?? null
    },
    headerTitles: () =>
      [...document.querySelectorAll<HTMLElement>('[title]')]
        .map(el => el.getAttribute('title') ?? '')
        .filter(Boolean),
    childSearchButton: (id: string) => {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      return [...(row?.querySelectorAll('button') ?? [])]
        .some(b => b.getAttribute('title') === 'Search children')
    },
    async openChildSearch(id: string) {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      const button = [...(row?.querySelectorAll('button') ?? [])]
        .find(b => b.getAttribute('title') === 'Search children')
      if (!button) throw new Error(`no child-search button on ${id}`)
      await act(async () => { fireEvent.click(button) })
      await settle()
    },
    async typeChildSearch(query: string) {
      // The column's own input, driven the way a reader drives it — no prop
      // capture, no mock: this is the exact path to `onSearchChildren`.
      //
      // ENTER IS LOAD-BEARING. SearchBoxItem holds the text in local state
      // and only calls its `onChange` on Enter or blur, so a change event by
      // itself commits nothing — a test that stops there passes whether the
      // handler is gated or not.
      const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search node"]')
      if (!input) return false
      await act(async () => {
        fireEvent.change(input, { target: { value: query } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      await settle()
      return true
    },
    async pressKey(key: string) {
      await act(async () => { fireEvent.keyDown(document, { key }) })
      await settle()
    },
    async clickCard(id: string) {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      if (!row) throw new Error(`no card ${id}`)
      // The armed connect flow resolves its target by HIT-TESTING the click
      // point (`document.elementFromPoint` → nearest `layer-node-*`), and
      // jsdom has no hit-testing at all — it answers null, so the flow would
      // silently never resolve and a test asserting "no picker" would pass
      // against a canvas with no gates whatsoever. Point the hit test at the
      // row being clicked, for exactly this click.
      const realFromPoint = document.elementFromPoint
      document.elementFromPoint = (() => row) as typeof document.elementFromPoint
      try {
        await act(async () => { fireEvent.click(row) })
        await settle()
      } finally {
        document.elementFromPoint = realFromPoint
      }
    },
    connectPickerOpen: () =>
      [...document.querySelectorAll('h3')].some(h => h.textContent?.trim() === 'Connect'),
    connectHandle: (id: string) => {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      return !!row?.querySelector('[aria-label="Drag to connect"]')
    },
    async toggle(id: string) {
      const row = document.querySelector<HTMLElement>(`#${CSS.escape(CARD_ID_PREFIX + id)}`)
      const button = row?.querySelector('button')
      if (!button) throw new Error(`no toggle on ${id}`)
      await act(async () => { fireEvent.click(button) })
      await settle()
    },
    providerCalls: () => providerCalls.traceClosure,
    async setDirection(dir: 'up' | 'both' | 'down') {
      const name = dir === 'both' ? /both directions/i : dir === 'up' ? /upstream only/i : /downstream only/i
      await act(async () => { fireEvent.click(screen.getByRole('radio', { name })) })
      await settle()
    },
    async depthPreset(label: string | RegExp) {
      // The chip is in the canvas HEADER, not the dock; its popover portals
      // to document.body, so both queries go through `screen`. The chip is a
      // TOGGLE — clicking it again would close the popover it just opened.
      const chip = screen.getByRole('button', { name: /^depth/i })
      if (chip.getAttribute('aria-expanded') !== 'true') {
        await act(async () => { fireEvent.click(chip) })
        await settle()
      }
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
      await settle()
    },
    depthPresetValues: () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Trace depth settings"]')
      return [...(dialog?.querySelectorAll<HTMLElement>('button') ?? [])]
        .map(b => b.textContent?.match(/\d+\/\d+/)?.[0] ?? '')
        .filter(Boolean)
    },
    async commitDockDepth(value: number) {
      const slider = document.querySelector<HTMLInputElement>('#trace-bottom-dock-body input[type="range"]')
      if (!slider) throw new Error('the dock Settings sliders are not on screen')
      await act(async () => {
        fireEvent.change(slider, { target: { value: String(value) } })
        fireEvent.mouseUp(slider)
      })
      await settle()
    },
    async historyBack() {
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Previous trace"]')
      if (!button) throw new Error('the dock is not offering a Previous trace control')
      await act(async () => { fireEvent.click(button) })
      await settle()
    },
    async historyForward() {
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Next trace"]')
      if (!button) throw new Error('the dock is not offering a Next trace control')
      await act(async () => { fireEvent.click(button) })
      await settle()
    },
    async openDockSettings() {
      const expand = document.querySelector<HTMLButtonElement>('[aria-controls="trace-bottom-dock-body"]')
      if (!expand) throw new Error('the dock is not on screen')
      if (expand.getAttribute('aria-expanded') !== 'true') {
        await act(async () => { fireEvent.click(expand) })
        await wait(300)
        await settle()
      }
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /settings/i })) })
      // The tab bodies cross-fade with `mode="wait"`: the outgoing panel's
      // 180 ms exit has to finish before the incoming one mounts at all.
      await wait(400)
      await settle()
    },
    async flushExpansionRecord() {
      // Real time, not a fake timer: the canvas schedules the record with a
      // plain setTimeout and the rest of the harness runs on real timers.
      await wait(400)
      await settle()
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
