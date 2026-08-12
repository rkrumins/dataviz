/**
 * useLensContainer — "open this container and show me only what's inside
 * it that connects to the entity I'm focused on."
 *
 * THE fix for coarse partners being dead ends. A DATAPLATFORM or
 * CONTAINER neighbour summarises many finer entities; the lens used to
 * try resolving them with `getEdges({sourceUrns:[C], targetUrns:[F]})`,
 * but that query matches URNs EXACTLY (backend: `a.urn IN $sourceUrns
 * AND b.urn IN $targetUrns`, no containment descent), so it returned
 * nothing whenever the real lineage lived on entities *inside* C.
 *
 * `provider.expandAggregated` is the primitive that actually does the
 * job: it collects the descendants of BOTH anchors and returns only the
 * edges strictly between those two sets — literally "the children of C
 * that carry lineage to F".
 *
 * Same contract as useLensLineage: one fetch per (container, focal,
 * direction) per lens session, explicit retry only (never a loop), a
 * session token so a closed lens can't resurrect stale results, and
 * NOTHING is written to the canvas store — exploring in the lens never
 * mutates a curated view's scope.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'
import { CHILDREN_PAGE_SIZE } from '@/config/pagination'

/**
 * Bound on how many pass-through levels an open may skip in one go.
 *
 * Sized to a real estate rather than to a round number: `Data Domain >
 * Application > Container > Container > Database > Table` is five
 * steps from the domain to the tables, and a bound of 4 stopped one
 * short of the grain the user had focused at — so close that the
 * picture looked broken rather than bounded. Six leaves a step of
 * headroom, and `truncated` says so when even that runs out, because a
 * walk that stopped early must never read as an answer.
 */
export const FRAME_AUTO_STEPS = 6

export type ContainerDirection = 'in' | 'out'

export type LensContainerStatus = 'loading' | 'done' | 'error' | 'unsupported'

export interface ContainerOpenResult {
  /** The container actually opened. Differs from the card the user
   *  clicked whenever pass-through levels were auto-skipped, and it is
   *  the anchor any follow-up question about "what's in here" must use. */
  anchorUrn: string
  /** The entity this answer is ABOUT — what the contents connect to.
   *  Stamped so a caller can tell an answer for one partner from an
   *  answer for another. */
  partnerUrn: string
  /** Entities inside the container that connect to the focal. Empty when
   *  the container genuinely has no lineage with it (see `empty`). */
  nodes: LineageNode[]
  /** The lineage edges between those entities and the focal side. */
  edges: LineageEdge[]
  /** Containment edges the backend hydrated for the returned nodes —
   *  lets the caller show which sub-container each child lives in. */
  containmentEdges: LineageEdge[]
  /** Levels auto-skipped because each held exactly one relevant child;
   *  rendered as a breadcrumb so a skipped level is never hidden. */
  passedThrough: LineageNode[]
  /** The server stopped early — counts are floors, not totals. */
  truncated: boolean
  /** Fetch completed and NOTHING inside connects to the focal. This is a
   *  data-source claim, distinct from "not fetched yet". */
  empty: boolean
}

/**
 * Everything inside an opened container, connected or not — the answer
 * behind "show all children". Deliberately a SEPARATE fetch: the server
 * has no way to ask "children of C, flagged by whether they reach F",
 * so we take the pair-filtered set (ContainerOpenResult) as the truth
 * about lineage and this set as the truth about membership.
 */
export interface ContainerAllResult {
  /** Children in the server's own order, accumulated across pages. */
  children: LineageNode[]
  /** More pages exist on the server. */
  hasMore: boolean
  /** Authoritative child count when the anchor reports one; null when
   *  unknown — callers must render a floor, never a fabricated total.
   *  (The endpoint's own `totalChildren` is a paging heuristic, not a
   *  count, so it is deliberately ignored.) */
  total: number | null
  /** The search this page set answers; absent or '' for the unfiltered
   *  list. A new query is a new question: pages reset rather than
   *  appending to the previous answer. */
  query?: string
}

export interface LensContainerData {
  results: Map<string, ContainerOpenResult>
  status: Map<string, LensContainerStatus>
  /** Every child of an opened container, keyed like `results`. */
  allResults: Map<string, ContainerAllResult>
  allStatus: Map<string, LensContainerStatus>
  /** Fetch (or page further into) every child of an already-open
   *  container. No-op until that open has resolved — the anchor to ask
   *  about is only known once the pass-through walk has finished. */
  loadAllChildren: (openKey: string, focalUrn: string, searchQuery?: string) => void
  /** Fetch (or page further into) any entity's children — the focal's
   *  own contents, or a contained child's, without leaving the lens. */
  loadChildrenOf: (nodeUrn: string, focalUrn: string) => void
  /** Open a container against the entity it is actually connected to
   *  (idempotent per key). `partnerUrn` is the focal only at the first
   *  hop — further out it is the card's previous-band partner, and
   *  asking about the focal there is answered, correctly and uselessly,
   *  with "nothing connects". `focalUrn` only buckets the cache. */
  openContainer: (
    containerUrn: string,
    focalUrn: string,
    partnerUrn: string,
    direction: ContainerDirection,
    /** Hierarchy level of the CONTAINER's entity type, when the ontology
     *  declares one. `null` is a legitimate answer, not a missing value:
     *  a type that appears at two containment depths (a Container inside
     *  a Container) has no single level, and the server drills
     *  structurally when none is sent. Callers must not invent one. */
    containerLevel: number | null,
  ) => void
  /** Re-kick a failed open. */
  retry: (
    containerUrn: string,
    focalUrn: string,
    partnerUrn: string,
    direction: ContainerDirection,
    containerLevel: number | null,
  ) => void
}

/**
 * Stable identity for one (container, focal, direction) opening — used
 * for the once-per-session fetch guard only, never parsed back apart.
 */
export const containerKey = (
  containerUrn: string,
  partnerUrn: string,
  direction: ContainerDirection,
): string => `${direction}:${containerUrn}->${partnerUrn}`

/**
 * The key callers use. They are already scoped to one focal, so they
 * key everything `${dir}:${urn}` — and the cache is stored per focal so
 * this view needs no parsing (urns may contain any punctuation).
 */
export const openKeyOf = (
  containerUrn: string,
  direction: ContainerDirection,
): string => `${direction}:${containerUrn}`

/** Cache key for "the children of this entity", deliberately outside
 *  the `${dir}:${urn}` space that opened containers use. */
export const childrenKeyOf = (nodeUrn: string): string => `kids:${nodeUrn}`

/**
 * Answers are stored per focal, because an answer only means anything
 * for the entity it was asked about. Nesting (rather than flattening
 * into one composite string key) keeps the exposed per-focal view a
 * plain lookup instead of a urn-parsing exercise.
 */
interface ContainerState {
  /** focalUrn → openKey (`${dir}:${urn}`) → result */
  results: Map<string, Map<string, ContainerOpenResult>>
  status: Map<string, Map<string, LensContainerStatus>>
  allResults: Map<string, Map<string, ContainerAllResult>>
  allStatus: Map<string, Map<string, LensContainerStatus>>
}

const emptyState = (): ContainerState => ({
  results: new Map(), status: new Map(), allResults: new Map(), allStatus: new Map(),
})

const EMPTY_RESULTS: Map<string, ContainerOpenResult> = new Map()
const EMPTY_STATUS: Map<string, LensContainerStatus> = new Map()
const EMPTY_ALL: Map<string, ContainerAllResult> = new Map()

/** Immutable nested set — copies only the focal's inner map. */
function setIn<V>(
  outer: Map<string, Map<string, V>>,
  focalUrn: string,
  key: string,
  value: V,
): Map<string, Map<string, V>> {
  const next = new Map(outer)
  const inner = new Map<string, V>(next.get(focalUrn) ?? [])
  inner.set(key, value)
  next.set(focalUrn, inner)
  return next
}

export function useLensContainer(
  /** Current focal, or null when the lens is closed (clears the session). */
  focalId: string | null,
  /** Null = no provider reachable; every open degrades to 'unsupported'. */
  provider: GraphDataProvider | null,
  lineageEdgeTypes: string[],
): LensContainerData {
  const [state, setState] = useState<ContainerState>(emptyState)
  const startedRef = useRef<Set<string>>(new Set())
  const inFlightRef = useRef<Set<string>>(new Set())
  const sessionRef = useRef(0)
  // `loadAllChildren` needs the anchor and the page count already in
  // state; it only ever runs from an event handler, so a committed
  // mirror is current by the time it reads.
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const runOpen = useCallback(async (
    containerUrn: string,
    focalUrn: string,
    partnerUrn: string,
    direction: ContainerDirection,
    containerLevel: number | null,
  ) => {
    const key = containerKey(containerUrn, partnerUrn, direction)
    const openKey = openKeyOf(containerUrn, direction)
    // Optional provider capability — absent means we cannot answer, and
    // saying so beats rendering a wrong or empty picture.
    if (!provider?.expandAggregated) {
      setState(prev => ({ ...prev, status: setIn(prev.status, focalUrn, openKey, 'unsupported') }))
      return
    }
    const session = sessionRef.current
    startedRef.current.add(key)
    setState(prev => ({ ...prev, status: setIn(prev.status, focalUrn, openKey, 'loading') }))

    try {
      const types = lineageEdgeTypes.length > 0 ? lineageEdgeTypes : null
      const passedThrough: LineageNode[] = []
      let anchor = containerUrn
      let level = containerLevel
      let nodes: LineageNode[] = []
      let edges: LineageEdge[] = []
      let containmentEdges: LineageEdge[] = []
      let truncated = false
      let empty = false

      // Open one level, then keep going while a level holds exactly one
      // relevant child — a container that only passes lineage through
      // costs the user a click for no information. Every skipped level
      // is recorded for the breadcrumb, so nothing is hidden.
      for (let step = 0; step < FRAME_AUTO_STEPS; step++) {
        const res = await provider.expandAggregated({
          // Direction decides which anchor is the source: upstream means
          // the container feeds the focal.
          sourceUrn: direction === 'in' ? anchor : partnerUrn,
          targetUrn: direction === 'in' ? partnerUrn : anchor,
          nextLevel: level === null ? null : level + 1,
          // Only the container descends. The partner is the QUESTION —
          // stepping it too is why opening a Domain against a table five
          // levels below returned "nothing connects" about lineage that
          // exists.
          drillAnchor: anchor,
          lineageEdgeTypes: types,
          includeContainmentEdges: true,
        })
        if (session !== sessionRef.current) return

        // CRITICAL: with zero edges the backend returns every collected
        // child of BOTH anchors — "no lineage" and "all children" arrive
        // in the same shape. Treat it as the honest empty answer and
        // discard the nodes rather than showing unrelated content.
        if (res.edges.length === 0) {
          nodes = []
          edges = []
          containmentEdges = []
          truncated = truncated || res.truncated
          empty = true
          break
        }

        // Keep only entities that are actually inside the container we
        // opened — the response also carries the focal side's endpoints.
        //
        // Filtering the two ANCHORS alone was not enough: the partner's
        // own DESCENDANTS passed straight through, so the focal's columns
        // were drawn as children of the upstream container's frame. With
        // the contains stack collapsed by default, the one-card-per-
        // entity gate never caught them either. Walk the containment
        // edges the response already carries.
        const parentOf = new Map<string, string>()
        for (const ce of res.containmentEdges ?? []) parentOf.set(ce.targetUrn, ce.sourceUrn)
        const onPartnerSide = (urn: string): boolean => {
          let cur: string | undefined = urn
          const seen = new Set<string>()
          while (cur && !seen.has(cur)) {
            if (cur === partnerUrn) return true
            seen.add(cur)
            cur = parentOf.get(cur)
          }
          return false
        }
        const inside = res.nodes.filter(n => n.urn !== anchor && !onPartnerSide(n.urn))

        // Explicit arrows: toCanvasNode takes an options 2nd arg, so a
        // bare `.map(toCanvasNode)` would hand it the array index.
        nodes = inside.map(n => toCanvasNode(n))
        edges = res.edges.map(e => toCanvasEdge(e))
        containmentEdges = (res.containmentEdges ?? []).map(e => toCanvasEdge(e))
        truncated = truncated || res.truncated
        empty = false

        if (nodes.length !== 1) break
        // Exactly one child: descend through it, recording the step.
        // The walk follows the CONNECTED path — a level with one
        // relevant child costs a click for no information, and a level
        // with several is a real branch worth stopping at.
        passedThrough.push(nodes[0])
        anchor = nodes[0].id
        if (level !== null) level += 1
        // Ran out of budget mid-chain. Say so: `truncated` renders as a
        // floor and keeps the frame's counts honest, rather than
        // presenting a stopped walk as a finished one.
        if (step === FRAME_AUTO_STEPS - 1) truncated = true
      }

      if (session !== sessionRef.current) return
      setState(prev => ({
        ...prev,
        results: setIn(prev.results, focalUrn, openKey,
          { anchorUrn: anchor, partnerUrn, nodes, edges, containmentEdges, passedThrough, truncated, empty }),
        status: setIn(prev.status, focalUrn, openKey, 'done'),
      }))
    } catch {
      if (session !== sessionRef.current) return
      // Allow an explicit retry to re-kick a failed open.
      startedRef.current.delete(key)
      setState(prev => ({ ...prev, status: setIn(prev.status, focalUrn, openKey, 'error') }))
    }
  }, [provider, lineageEdgeTypes])

  const openContainer = useCallback((
    containerUrn: string,
    focalUrn: string,
    partnerUrn: string,
    direction: ContainerDirection,
    containerLevel: number | null,
  ) => {
    // Keyed by PARTNER: the same container opened from two different
    // places is two different questions, and a focal-only key would let
    // the first answer swallow the second.
    const key = containerKey(containerUrn, partnerUrn, direction)
    if (startedRef.current.has(key)) return
    void runOpen(containerUrn, focalUrn, partnerUrn, direction, containerLevel)
  }, [runOpen])

  const retry = useCallback((
    containerUrn: string,
    focalUrn: string,
    partnerUrn: string,
    direction: ContainerDirection,
    containerLevel: number | null,
  ) => void runOpen(containerUrn, focalUrn, partnerUrn, direction, containerLevel), [runOpen])

  /**
   * Every child of an opened container — the "show all" answer.
   *
   * Offset paging, not cursor: the versioned-branch provider ignores
   * cursors (and search, and sort) entirely, while offset/limit works on
   * every backend. Lineage edges are skipped because the ones this
   * endpoint returns are scoped to the page's own siblings and never
   * include the focal — the pair-filtered open already answered that.
   */
  const pageChildren = useCallback((cacheKey: string, anchorUrn: string, focalUrn: string, searchQuery = '') => {
    if (!provider) {
      setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, focalUrn, cacheKey, 'unsupported') }))
      return
    }
    const inFlightKey = `${focalUrn}|${cacheKey}`
    if (inFlightRef.current.has(inFlightKey)) return

    const q = searchQuery.trim()
    const loaded = stateRef.current.allResults.get(focalUrn)?.get(cacheKey)
    // A changed search is a different question — page it from zero
    // instead of appending matches to the previous answer.
    const sameQuery = (loaded?.query ?? '') === q
    if (loaded && sameQuery && !loaded.hasMore) return // fully drained already

    const session = sessionRef.current
    inFlightRef.current.add(inFlightKey)
    setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, focalUrn, cacheKey, 'loading') }))

    void (async () => {
      try {
        const res = await provider.getChildrenWithEdges(anchorUrn, {
          limit: CHILDREN_PAGE_SIZE,
          offset: sameQuery ? (loaded?.children.length ?? 0) : 0,
          includeLineageEdges: false,
          // Server-side, so Find reaches a column on page 7 of a wide
          // table without paging to it. Filtering the loaded page in the
          // browser could only ever search what you had already read.
          ...(q ? { searchQuery: q } : {}),
        })
        if (session !== sessionRef.current) return
        const page = res.children.map(n => toCanvasNode(n))
        setState(prev => {
          const prevPage = prev.allResults.get(focalUrn)?.get(cacheKey)
          const children = sameQuery ? [...(prevPage?.children ?? []), ...page] : page
          return {
            ...prev,
            allResults: setIn(prev.allResults, focalUrn, cacheKey, {
              children,
              hasMore: res.hasMore,
              // Draining the last page is the one moment we know the
              // real count. Until then it is genuinely unknown — the
              // endpoint's own totalChildren is a paging heuristic.
              total: res.hasMore ? null : children.length,
              query: q,
            }),
            allStatus: setIn(prev.allStatus, focalUrn, cacheKey, 'done'),
          }
        })
      } catch {
        if (session !== sessionRef.current) return
        setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, focalUrn, cacheKey, 'error') }))
      } finally {
        inFlightRef.current.delete(inFlightKey)
      }
    })()
  }, [provider])

  const loadAllChildren = useCallback((openKey: string, focalUrn: string, searchQuery = '') => {
    const open = stateRef.current.results.get(focalUrn)?.get(openKey)
    // Until the open resolves we don't know WHICH container to ask
    // about — pass-through levels may still be being walked.
    if (!open) return
    pageChildren(openKey, open.anchorUrn, focalUrn, searchQuery)
  }, [pageChildren])

  /**
   * The children of ANY entity, asked for directly.
   *
   * The lens used to derive an entity's children purely from
   * containment edges that happened to be loaded on the canvas, while
   * reading the real total from `childCount`. So it would say "contains
   * 128" and have no way to show one of them: you had to leave Focus
   * mode, expand the node on the canvas, and come back. This is the
   * fetch that was missing.
   */
  const loadChildrenOf = useCallback(
    (nodeUrn: string, focalUrn: string) => pageChildren(childrenKeyOf(nodeUrn), nodeUrn, focalUrn),
    [pageChildren],
  )

  // Session lifecycle: clear everything when the lens closes so a new
  // session starts from the data source, not from a stale picture.
  useEffect(() => {
    if (focalId) return
    if (startedRef.current.size === 0 && inFlightRef.current.size === 0) return
    sessionRef.current += 1
    startedRef.current.clear()
    inFlightRef.current.clear()
    setState(emptyState())
  }, [focalId])

  // What callers see: this focal's answers, keyed the way they key
  // everything else (`${dir}:${urn}`). Other focals' answers stay in
  // the cache so stepping back is instant, but they are never visible
  // here — an answer about another entity would be a wrong answer.
  const results = (focalId ? state.results.get(focalId) : undefined) ?? EMPTY_RESULTS
  const status = (focalId ? state.status.get(focalId) : undefined) ?? EMPTY_STATUS
  const allResults = (focalId ? state.allResults.get(focalId) : undefined) ?? EMPTY_ALL
  const allStatus = (focalId ? state.allStatus.get(focalId) : undefined) ?? EMPTY_STATUS

  return { results, status, allResults, allStatus, loadAllChildren, loadChildrenOf, openContainer, retry }
}
