/**
 * LineageLens — "click an entity, see its lineage", at any canvas scale.
 *
 * The focal entity sits centered; upstream (data sources) on the LEFT,
 * downstream (consumers) on the RIGHT. Data flow reads left → right
 * throughout. Re-centering on a neighbour is a WALK recorded in a
 * browser-style focus history (Back/Forward, ←/→ keys, clickable Path
 * trail — moving the cursor never drops a hop); the SAME body renders at
 * every depth, so a walk never flips the layout.
 *
 * EVERY NUMBER ON THE BOARD IS SERVER TRUTH. The lens reads ONE thing:
 * the accumulated walk model for the current focal (`useLensWalk`), a
 * client-side union of one-hop closure responses. It does not read the
 * canvas store at all — what happens to be hydrated on the canvas is a
 * fact about the canvas, and the lens is asked about the DATA SOURCE.
 * The pipeline is four pure steps:
 *
 *   walk model → buildLensSubgraph → buildFocusLayout → FocusGraphView
 *
 * with a per-focal `LensViewState` (what the user has opened, revealed,
 * searched) as the only other input. Because the layout is a pure
 * re-projection over the model, expanding a container is free and can
 * never reach outside the lineage: the model's children are already
 * scoped to walk participants. The only things that cost a round trip
 * are ⊕ extend / page (one further hop) and "everything inside" (the
 * roster of what a container holds, which lineage cannot answer).
 *
 * Styling is dual-theme (black/* light + white/* dark overlay pairs) on
 * a SOLID elevated surface — translucent glass over a busy canvas read
 * as washed-out, especially in light mode. Lens-local ESC handling runs
 * in the capture phase so canvas keyboard shortcuts don't fire
 * underneath.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useRelationshipTypes } from '@/store/schema'
import { relationshipLabel } from '@/lib/relationshipLabel'
import type { WalkEntry, LensWalkDir } from '@/hooks/useLensWalk'
import { emptyWalkModel, type LensWalkNode } from './lens/closure-adapter'
import {
  buildLensSubgraph,
  type LensSubgraph,
} from './lens/lens-subgraph'
import {
  buildFocusLayout,
  initialLensViewState,
  type LensFetchStatus,
  type LensRoster,
  type LensViewState,
} from './lens/focus-layout'
import { generateColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'
import { useTourStore } from '@/features/tour/tourStore'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { lensFocalOf, type LensHistory } from './lens/lensHistory'
import { labelOf, edgeLabelFor, type EdgeTypeInfoMap, type LensReach } from './lens/focus-cards'
import { encodeLensShare } from './lens/shareCodec'
import { FocusGraphView } from './lens/FocusGraphView'

/** Leaves one ⊕ extend ships to the server. A hub can stand for
 *  thousands of participants; the request has to stay a request. */
const SEED_CAP = 500
const EMPTY_TYPE_SET: ReadonlySet<string> = new Set()
const EMPTY_EXTEND_STATUS: ReadonlyMap<string, 'loading' | 'error'> = new Map()
const EMPTY_ROSTERS: ReadonlyMap<string, LensRoster> = new Map()
const EMPTY_ROSTER_STATUS: ReadonlyMap<string, LensFetchStatus> = new Map()

/** One hop-1 neighbour of the focus, as the walk model reports it —
 *  the same edges the graph body draws, counted the same way, so the
 *  two bodies cannot disagree about what is connected. */
interface WalkNeighbor {
  urn: string
  label: string
  type: string
  /** Raw hops between this entity and the focus side. */
  weight: number
  /** The one relationship type these hops share, '' when they differ. */
  edgeTypeNorm: string
  parentUrn: string | null
  parentLabel: string | null
}

/**
 * The focus's direct neighbours, straight off the walk model.
 *
 * "Hop 1" is structural: a lineage edge with one endpoint on the FOCUS
 * SIDE (the focus plus everything contained in it — a container has no
 * edges of its own, only its descendants do) and the other outside it.
 * That is exactly the rule `buildLensSubgraph` uses to number hops, so
 * the list body and the graph body are two renderings of one fact.
 */
function walkNeighborRecords(sg: LensSubgraph<LensWalkNode>): {
  incoming: WalkNeighbor[]
  outgoing: WalkNeighbor[]
} {
  const focusSide = new Set<string>()
  const stack = [sg.focusUrn]
  while (stack.length > 0) {
    const urn = stack.pop()!
    if (focusSide.has(urn) || !sg.nodes.has(urn)) continue
    focusSide.add(urn)
    for (const child of sg.nodes.get(urn)!.children) stack.push(child)
  }

  const build = (dir: 'in' | 'out'): WalkNeighbor[] => {
    const byUrn = new Map<string, { weight: number; types: Set<string> }>()
    for (const hop of sg.lineageEdges) {
      const near = dir === 'in' ? hop.targetUrn : hop.sourceUrn
      const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
      if (!focusSide.has(near) || focusSide.has(far)) continue
      const entry = byUrn.get(far) ?? { weight: 0, types: new Set<string>() }
      entry.weight += 1
      entry.types.add((hop.edgeType ?? '').toUpperCase())
      byUrn.set(far, entry)
    }
    const labelFor = (urn: string) => labelOf(urn, sg.nodes.get(urn)?.node)
    return [...byUrn.entries()]
      .map(([urn, { weight, types }]) => {
        const node = sg.nodes.get(urn)
        const parentUrn = node?.parent ?? null
        return {
          urn,
          label: labelFor(urn),
          type: (node?.node?.data?.type as string) ?? node?.node?.entityType ?? 'not loaded',
          weight,
          edgeTypeNorm: types.size === 1 ? [...types][0] : '',
          parentUrn,
          parentLabel: parentUrn ? labelFor(parentUrn) : null,
        }
      })
      .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label) || a.urn.localeCompare(b.urn))
  }

  return { incoming: build('in'), outgoing: build('out') }
}

/**
 * The leaves an ⊕ extend is seeded from: the lineage-participating
 * members of the card's own subtree, in this direction.
 *
 * A card stands for everything inside it, so extending a collapsed
 * table means "walk one hop further from the columns underneath it" —
 * the server needs those columns by name. Ranked by how much lineage
 * each already carries so a capped request spends its budget on the
 * busiest participants.
 *
 * A member with NO loaded edges in this direction but a frontier entry
 * from the server counts too: that is precisely a node whose lineage
 * has not been fetched yet, and dropping it would seed the request with
 * everything except the reason it exists.
 */
function seedLeavesFor(
  sg: LensSubgraph<LensWalkNode>,
  cardUrn: string,
  dir: 'in' | 'out',
): string[] {
  const members: Array<{ urn: string; degree: number }> = []
  const stack = [cardUrn]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const urn = stack.pop()!
    if (seen.has(urn)) continue
    seen.add(urn)
    const node = sg.nodes.get(urn)
    if (!node) continue
    const degree = dir === 'in' ? node.degreeUp : node.degreeDown
    const frontier = dir === 'in' ? node.frontierUp : node.frontierDown
    if (degree > 0 || frontier != null) members.push({ urn, degree })
    for (const child of node.children) stack.push(child)
  }
  return members
    .sort((a, b) => b.degree - a.degree || a.urn.localeCompare(b.urn))
    .slice(0, SEED_CAP)
    .map(m => m.urn)
}

const toWalkDir = (dir: 'in' | 'out'): LensWalkDir => (dir === 'in' ? 'up' : 'down')

/** Every walk affordance the lens hands to the hook. Grouped because
 *  they are one capability — "grow this focal's model" — and a caller
 *  holding three of the four would be holding a broken one. */
export interface LensWalkApi {
  extend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
  page: (cardUrn: string, dir: LensWalkDir, cursor: string) => void
  retry: (focusUrn: string) => void
  retryExtend: (cardUrn: string, dir: LensWalkDir, seedLeaves: string[]) => void
}

export interface LineageLensProps {
  /** Focus history; entries[cursor] is the current focal. Empty = closed. */
  history: LensHistory
  /** The accumulated walk for the CURRENT focal, or null before the
   *  hook has touched it. Every number the lens shows comes from here. */
  walk: WalkEntry | null
  /** Growing that model: one further hop, one further page, or again
   *  after a failure. */
  walkApi: LensWalkApi
  /** "What is really inside this entity" per urn — membership, which
   *  lineage cannot answer (useLensChildren). */
  childrenAll?: ReadonlyMap<string, LensRoster>
  childrenAllStatus?: ReadonlyMap<string, LensFetchStatus>
  /** Fetch (or page further into, or search within) a container's full
   *  child list. `searchQuery` goes to the server, so Find reaches rows
   *  that have not been paged to yet. */
  onLoadAllChildren?: (urn: string, searchQuery?: string) => void
  onLoadChildrenOf?: (urn: string) => void
  onRecenter: (nodeId: string) => void
  /** Step the focus history back one hop (non-destructive). */
  onBack: () => void
  /** Step the focus history forward one hop (non-destructive). */
  onForward: () => void
  /** Move the history cursor to entry i without dropping the trail. */
  onJumpTo?: (index: number) => void
  /** Frame the walked path on the canvas (closes the lens). */
  onShowPathOnCanvas?: (ids: string[]) => void
  onClose: () => void
  /** Reveal the node on the canvas (expand ancestors + scroll) without closing the lens. */
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  /** Open the entity drawer for a node. */
  onOpenDetails?: (nodeId: string) => void
  /** Reveal a set of neighbors and frame them on the canvas (closes the lens). */
  onLocateAll?: (nodeIds: string[]) => void | Promise<void>
  /** Escalate to a full server trace from the focal node (closes the lens). */
  onTrace?: (nodeId: string) => void
  /** Feature-flagged out-of-view preview for the focal node: partners
   *  that exist in the data source but are outside this view's scope.
   *  Advisory only — never part of the canvas. */
  externalPreview?: {
    loading: boolean
    records: Array<{ urn: string; label: string; direction: 'in' | 'out'; edgeType: string }>
  } | null
}

export function LineageLens({
  history,
  walk,
  walkApi,
  childrenAll = EMPTY_ROSTERS,
  childrenAllStatus = EMPTY_ROSTER_STATUS,
  onLoadAllChildren,
  onLoadChildrenOf,
  onRecenter,
  onBack,
  onForward,
  onJumpTo,
  onShowPathOnCanvas,
  onClose,
  onRevealOnCanvas,
  onOpenDetails,
  onLocateAll,
  onTrace,
  externalPreview,
}: LineageLensProps) {
  const { entries, cursor } = history
  const nodeId = lensFocalOf(history)
  const canBack = cursor > 0
  const canForward = cursor < entries.length - 1

  // Query is keyed to the focal node — re-centering starts with a fresh
  // filter without needing a reset effect.
  const [queryState, setQueryState] = useState<{ nodeId: string | null; q: string }>({ nodeId: null, q: '' })
  const query = queryState.nodeId === nodeId ? queryState.q : ''
  const setQuery = (q: string) => setQueryState({ nodeId, q })

  // Lens-local ESC: capture phase so the canvas's document-level keyboard
  // handler never sees it while the lens is open.
  useEffect(() => {
    if (!nodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      // Keyboard walking: ← back one hop, → forward one hop — browser
      // history semantics (never while typing in the filter input).
      if ((e.key === 'ArrowLeft' && canBack) || (e.key === 'ArrowRight' && canForward)) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowLeft') onBack()
        else onForward()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, onClose, canBack, canForward, onBack, onForward])

  const walkStatus: LensFetchStatus = walk?.status ?? 'loading'
  const model = walk?.model ?? null

  // ── The pipeline: model → subgraph → view state → layout ──────────

  const sg = useMemo(
    () => buildLensSubgraph(model ?? emptyWalkModel(nodeId ?? '')),
    [model, nodeId],
  )

  // Where a walk starts: the focus's containment spine already open and
  // one page of neighbours each way. Recomputed only when the model
  // changes, so it is a stable identity for the layout memo below.
  const initialView = useMemo(() => initialLensViewState(sg), [sg])
  const [viewState, setViewState] = useState<{ nodeId: string | null; view: LensViewState } | null>(null)
  // Discarded on re-center, exactly like the filter and chip state: a
  // new focal is a new question, not a continuation of this one.
  //
  // Restoring a SHARED exploration lands here in the next task, which
  // re-encodes this state as share v2. The v1 fields (collapsed /
  // frontier / containers / contains / framePages / frameQueries)
  // describe a state model that no longer exists, so nothing consumes
  // them: a v1 link still restores the walked path and the body mode.
  const view = viewState?.nodeId === nodeId ? viewState.view : initialView
  const editView = useCallback((edit: (base: LensViewState) => LensViewState) => {
    setViewState(prev => ({
      nodeId,
      view: edit(prev?.nodeId === nodeId ? prev.view : initialView),
    }))
  }, [nodeId, initialView])

  // Type-filter chips — lens-local, keyed to the focal (like the text
  // filter) so re-centering starts clean.
  const [hiddenTypesState, setHiddenTypesState] = useState<{ nodeId: string | null; types: ReadonlySet<string> }>({ nodeId: null, types: EMPTY_TYPE_SET })
  const hiddenTypes = hiddenTypesState.nodeId === nodeId ? hiddenTypesState.types : EMPTY_TYPE_SET
  const toggleHiddenType = (t: string) => setHiddenTypesState(prev => {
    const base = prev.nodeId === nodeId ? prev.types : EMPTY_TYPE_SET
    const next = new Set(base)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    return { nodeId, types: next }
  })

  const lensViewMode = usePreferencesStore((s) => s.lensViewMode)
  const setLensViewMode = usePreferencesStore((s) => s.setLensViewMode)
  const lensFrameChildren = usePreferencesStore((s) => s.lensFrameChildren)
  const setLensFrameChildren = usePreferencesStore((s) => s.setLensFrameChildren)
  const reducedMotion = usePreferencesStore((s) => s.reducedMotion)

  const layout = useMemo(() => buildFocusLayout({
    sg,
    view,
    query,
    hiddenTypes,
    extendStatus: walk?.extendStatus ?? EMPTY_EXTEND_STATUS,
    childrenAll,
    childrenAllStatus,
    walkStatus,
  }), [sg, view, query, hiddenTypes, walk?.extendStatus, childrenAll, childrenAllStatus, walkStatus])

  const neighbors = useMemo(() => walkNeighborRecords(sg), [sg])
  const inConnections = neighbors.incoming.reduce((n, r) => n + r.weight, 0)
  const outConnections = neighbors.outgoing.reduce((n, r) => n + r.weight, 0)

  // ── Growing the walk ───────────────────────────────────────────────

  /** Instant: a page of neighbours already in the model. No fetch. */
  const revealMore = useCallback((key: string) => {
    editView(base => {
      const revealed = new Map(base.revealed)
      revealed.set(key, (revealed.get(key) ?? 0) + 1)
      return { ...base, revealed }
    })
  }, [editView])

  /** One further hop from this card, seeded by what is underneath it. */
  const extendWalk = useCallback((_key: string, urn: string, dir: 'in' | 'out') => {
    walkApi.extend(urn, toWalkDir(dir), seedLeavesFor(sg, urn, dir))
  }, [walkApi, sg])

  /** The rest of THIS node's adjacency, with the server's own cursor. */
  const pageWalk = useCallback((urn: string, dir: 'in' | 'out', cursor: string) => {
    walkApi.page(urn, toWalkDir(dir), cursor)
  }, [walkApi])

  /** Which cards the LAYOUT opened by itself, so a click on one can
   *  close it. Read from the built cards rather than re-deriving the
   *  pass-through-spine rule, which would be a second copy of it. */
  const autoOpen = useMemo(() => {
    const open = new Set<string>()
    for (const card of layout.cards) {
      if (card.kind === 'frame' && card.nodeId) open.add(card.nodeId)
    }
    return open
  }, [layout])

  /** Open / close what a card holds. Pure re-projection over the model
   *  — the children are already scoped to walk participants, so this can
   *  never reach outside the lineage and never fetches. */
  const toggleContents = useCallback((urn: string) => {
    let opening = false
    editView(base => {
      const expanded = new Set(base.expandedContainment)
      const collapsed = new Set(base.collapsedContainment)
      // The layout auto-opens pass-through spines, so "is it open" is
      // not "is it in the set" — an open the user shuts has to be
      // RECORDED, or the spine would reinstate it on the next build.
      const isOpen = !collapsed.has(urn) && (expanded.has(urn) || autoOpen.has(urn))
      opening = !isOpen
      if (isOpen) {
        expanded.delete(urn)
        collapsed.add(urn)
      } else {
        expanded.add(urn)
        collapsed.delete(urn)
      }
      // A newly opened frame starts in whichever mode the header says.
      const showAll = new Set(base.frameShowAll)
      if (opening && lensFrameChildren === 'all') showAll.add(urn)
      return { ...base, expandedContainment: expanded, collapsedContainment: collapsed, frameShowAll: showAll }
    })
    if (opening && lensFrameChildren === 'all') onLoadAllChildren?.(urn)
  }, [editView, autoOpen, lensFrameChildren, onLoadAllChildren])

  /** Flip one frame between "only what connects" and "everything
   *  inside". Turning it on fetches the roster; turning it off keeps
   *  the answer cached for flipping back. */
  const toggleFrameAll = useCallback((urn: string) => {
    let turningOn = false
    editView(base => {
      const next = new Set(base.frameShowAll)
      turningOn = !next.has(urn)
      if (turningOn) next.add(urn)
      else next.delete(urn)
      return { ...base, frameShowAll: next }
    })
    if (turningOn) onLoadAllChildren?.(urn)
  }, [editView, onLoadAllChildren])

  const setFrameQuery = useCallback((urn: string, q: string) => {
    editView(base => {
      const queries = new Map(base.frameQueries)
      if (q) queries.set(urn, q)
      else queries.delete(urn)
      // A new search is a new list — start it at the top rather than
      // leaving the window parked on a page the matches may not reach.
      const pages = new Map(base.framePages)
      pages.delete(urn)
      return { ...base, frameQueries: queries, framePages: pages }
    })
  }, [editView])

  const frameQueryFor = useCallback(
    (urn: string) => view.frameQueries.get(urn) ?? '',
    [view.frameQueries],
  )

  /**
   * Find, debounced into the server.
   *
   * `getChildrenWithEdges` matches displayName/urn server-side, so Find
   * reaches a column on page 7 of a wide table without paging to it.
   * Connected mode needs none of this: its set is the model already in
   * hand, and the layout filters it locally.
   */
  const frameQueriesNow = view.frameQueries
  const frameShowAllNow = view.frameShowAll
  useEffect(() => {
    if (!onLoadAllChildren || frameShowAllNow.size === 0) return
    const t = setTimeout(() => {
      for (const urn of frameShowAllNow) {
        const want = (frameQueriesNow.get(urn) ?? '').trim()
        const have = childrenAll.get(urn)
        // Only when the question CHANGED — otherwise this would race the
        // frame's own first-page fetch and quietly page past it.
        if (!have || (have.query ?? '') === want) continue
        onLoadAllChildren(urn, want)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [frameQueriesNow, frameShowAllNow, childrenAll, onLoadAllChildren])

  /** Move a frame's fixed window to an absolute page. Fetching is
   *  decoupled from the window: one server page backs several render
   *  pages, so we only ask when the window runs past what is loaded. */
  const setFramePage = useCallback((urn: string, page: number) => {
    let showingAll = false
    let q = ''
    editView(base => {
      showingAll = base.frameShowAll.has(urn)
      // The page we turn to belongs to whatever list is on screen.
      // Asking without the query made the hook see a DIFFERENT question
      // and refetch page 1 unfiltered.
      q = base.frameQueries.get(urn) ?? ''
      const pages = new Map(base.framePages)
      pages.set(urn, Math.max(0, page))
      return { ...base, framePages: pages }
    })
    if (!showingAll) return
    const loaded = childrenAll.get(urn)
    if (!loaded || loaded.hasMore) onLoadAllChildren?.(urn, q)
  }, [editView, childrenAll, onLoadAllChildren])

  const retryFrameAll = useCallback(
    (urn: string) => onLoadAllChildren?.(urn, view.frameQueries.get(urn) ?? ''),
    [onLoadAllChildren, view.frameQueries],
  )

  const retryWalk = useCallback(() => { if (nodeId) walkApi.retry(nodeId) }, [nodeId, walkApi])

  const setSelection = useCallback((selection: string | null) => {
    editView(base => ({ ...base, selection }))
  }, [editView])

  // ── Wording ────────────────────────────────────────────────────────

  const relationshipTypes = useRelationshipTypes()
  const edgeTypeInfo = useMemo<EdgeTypeInfoMap>(() => {
    const m: EdgeTypeInfoMap = new Map()
    for (const rt of relationshipTypes) {
      m.set(rt.id.toUpperCase(), { label: rt.name || relationshipLabel(rt.id), description: rt.description })
    }
    return m
  }, [relationshipTypes])

  // Deep walks middle-truncate so the cursor's neighborhood (the part
  // people care about) stays visible; the gap chips expand the full trail.
  const [showFullTrail, setShowFullTrail] = useState(false)
  const TRAIL_CAP = 6
  const collapseTrail = entries.length > TRAIL_CAP && !showFullTrail

  const labelFor = useCallback(
    (urn: string) => labelOf(urn, sg.nodes.get(urn)?.node),
    [sg],
  )
  const parentOf = useCallback(
    (urn: string) => sg.nodes.get(urn)?.parent ?? null,
    [sg],
  )

  // Hop metadata for the trail — direction + relationship for each
  // transition, so the path reads as a sentence rather than a list.
  // Only the hops the CURRENT focal's model can vouch for get one; the
  // rest fall back to a neutral separator, because a walk's earlier
  // hops live in other focals' models and guessing them would be
  // inventing lineage.
  const hopMeta = useMemo(() => {
    const meta: Array<{ downstream: boolean; edgeType: string } | null> = []
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]
      const curr = entries[i]
      let found: { downstream: boolean; edgeType: string } | null = null
      for (const e of sg.lineageEdges) {
        if (e.sourceUrn === prev && e.targetUrn === curr) {
          found = { downstream: true, edgeType: (e.edgeType ?? '') }
          break
        }
        if (e.sourceUrn === curr && e.targetUrn === prev) {
          found = { downstream: false, edgeType: (e.edgeType ?? '') }
          break
        }
      }
      meta.push(found)
    }
    return meta
  }, [entries, sg])

  // Type chips — every type the chips could actually remove. Never the
  // focus or the containers above it: chipping the focus's own type
  // would delete the thing you are looking at.
  const typeChips = useMemo(() => {
    const kept = new Set<string>([sg.focusUrn])
    let cursorUrn = sg.nodes.get(sg.focusUrn)?.parent ?? null
    while (cursorUrn && !kept.has(cursorUrn)) {
      kept.add(cursorUrn)
      cursorUrn = sg.nodes.get(cursorUrn)?.parent ?? null
    }
    const counts = new Map<string, number>()
    for (const [urn, node] of sg.nodes) {
      if (kept.has(urn)) continue
      const t = (node.node?.data?.type as string) ?? node.node?.entityType ?? 'not loaded'
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [sg])

  // Detail strip for the selected card — its own tallies, from the same
  // model everything else reads.
  const selectedInfo = useMemo(() => {
    const sel = view.selection
    const node = sel ? sg.nodes.get(sel) : undefined
    if (!sel || !node) return null
    return {
      id: sel,
      label: labelOf(sel, node.node),
      type: (node.node?.data?.type as string) ?? node.node?.entityType ?? 'not loaded',
      description: (node.node?.data?.description as string | undefined) ?? null,
      parentLabel: node.parent ? labelOf(node.parent, sg.nodes.get(node.parent)?.node) : null,
      inCount: node.degreeUp,
      outCount: node.degreeDown,
    }
  }, [view.selection, sg])

  // ── Share this exploration — the walked path as a link a colleague
  // can open. The EXPLORATION half is re-encoded in the next task; a
  // link written today restores the path and the body mode.
  const [shareCopied, setShareCopied] = useState(false)
  const copyShareLink = () => {
    const token = encodeLensShare({
      entries,
      cursor,
      mode: lensViewMode,
      closed: [],
      frontier: [],
      containers: [],
      frameAll: [],
      contains: [],
      framePages: [],
      frameQueries: [],
    })
    const url = new URL(window.location.href)
    url.searchParams.set('lens', token)
    void navigator.clipboard?.writeText(url.toString())
    setShareCopied(true)
    window.setTimeout(() => setShareCopied(false), 1600)
  }

  // ── Guided tour — offered ONCE, the first time the graph body opens
  // (rich gestures shouldn't be discovered by accident); replayable
  // from Help on any view afterwards.
  const lensOpen = entries.length > 0
  const tourStart = useTourStore((s) => s.start)
  const tourActive = useTourStore((s) => s.activeTourId)
  const hasCompletedTour = useTourStore((s) => s.hasCompleted)
  useEffect(() => {
    if (!lensOpen || lensViewMode !== 'graph' || tourActive) return
    if (hasCompletedTour('lineage-lens')) return
    try {
      if (localStorage.getItem('nx-lens-tour-offered')) return
      localStorage.setItem('nx-lens-tour-offered', '1')
    } catch {
      return
    }
    // Let the dialog and graph mount so the spotlight targets exist.
    const t = window.setTimeout(() => tourStart('lineage-lens'), 650)
    return () => window.clearTimeout(t)
  }, [lensOpen, lensViewMode, tourActive, hasCompletedTour, tourStart])

  // The focal's own contents, asked for once — the roster half, which
  // lineage cannot answer. Every read path strips childCount, so a
  // gate on it would hide the affordance exactly where it matters.
  const focalKidsAskedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!nodeId || !onLoadChildrenOf) return
    if (focalKidsAskedRef.current === nodeId) return
    if (walkStatus !== 'done') return
    focalKidsAskedRef.current = nodeId
    onLoadChildrenOf(nodeId)
  }, [nodeId, onLoadChildrenOf, walkStatus])

  if (!nodeId) return null

  const focalNode = sg.nodes.get(nodeId)?.node
  const focalLabel = labelOf(nodeId, focalNode)
  const focalType = (focalNode?.data?.type as string) ?? focalNode?.entityType ?? 'entity'
  const focalColor = generateColorFromType(focalType)
  const focalParentId = parentOf(nodeId)
  const focalParentLabel = focalParentId ? labelFor(focalParentId) : null
  // Header display suppresses the parent when the PREVIOUS hop already
  // is the parent (saying it twice reads as noise).
  const focalParentInHeader = focalParentId && focalParentId !== entries[cursor - 1]
    ? focalParentLabel
    : null
  const focalChildren = sg.nodes.get(nodeId)?.children ?? []
  const focalChildTotal = Math.max(
    focalChildren.length,
    (focalNode?.data?.childCount as number | undefined) ?? 0,
  )

  /**
   * How far the walk has actually reached, and whether that is the
   * whole story. Not a measurement of its own: these are the entities
   * the server has NAMED as upstream / downstream of the focus, which
   * is the number every other surface here is derived from.
   */
  const reach: LensReach | null = model && walkStatus === 'done'
    ? {
        up: model.upstreamUrns.size,
        down: model.downstreamUrns.size,
        more: model.frontierUp.length > 0 || model.frontierDown.length > 0
          || model.truncated || model.seedTruncated,
      }
    : null

  const headerConnections = inConnections + outConnections
  const q = query.trim().toLowerCase()
  const filterFn = (r: WalkNeighbor) => q === '' || r.label.toLowerCase().includes(q)

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="lineage-lens"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[9990] flex items-center justify-center p-6"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-2xl shadow-black/40 overflow-hidden transition-[width,height,max-height] duration-300"
          style={
            // Graph exploration is a "focus room" — near-fullscreen with
            // a RESOLVED height (React Flow needs one). The list keeps
            // its adaptive height so small neighborhoods don't get a
            // cavernous empty grid.
            lensViewMode === 'graph'
              ? { width: 'min(1800px, 96vw)', height: 'min(1100px, 94vh)' }
              : { width: 'min(1000px, 92vw)', maxHeight: 'min(72vh, 780px)', minHeight: 380 }
          }
          role="dialog"
          aria-label={`Connections of ${focalLabel}`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.08] dark:border-white/[0.08]">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${focalColor}1f` }}
            >
              <LucideIcons.Focus className="w-4 h-4" style={{ color: focalColor }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <h2 className="text-sm font-semibold text-ink leading-tight truncate">{focalLabel}</h2>
                {focalParentInHeader && (
                  <span className="flex-shrink-0 max-w-[160px] truncate text-[10px] text-ink-muted/70">
                    in {focalParentInHeader}
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1.5 text-[10.5px] text-ink-muted leading-tight">
                {/* Counted off the same model the board draws — there is
                    no second set of numbers to reconcile it against. */}
                <span>
                  {`${headerConnections} connection${headerConnections === 1 ? '' : 's'}${focalChildTotal > 0 ? ` · contains ${focalChildTotal}` : ''}`}
                </span>
                {walkStatus === 'loading' && (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
                )}
              </p>
            </div>
            {/* History navigation — browser semantics: Back/Forward move
                the cursor along the walked path without dropping hops.
                Forward appears only when there is a forward side. */}
            {canBack && (
              <button
                type="button"
                onClick={onBack}
                title="Step back one hop (←)"
                className="ml-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <LucideIcons.ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}
            {canForward && (
              <button
                type="button"
                onClick={onForward}
                title="Step forward one hop (→)"
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                  canBack ? 'ml-1' : 'ml-2',
                )}
              >
                Forward
                <LucideIcons.ArrowRight className="w-3 h-3" />
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {/* Gesture guide — the graph's interactions are rich, and
                  a first-time business user shouldn't have to discover
                  them by accident. */}
              <InfoTooltip
                side="bottom"
                align="end"
                content={
                  <div className="space-y-1 text-left">
                    <p className="font-semibold text-ink">Exploring lineage</p>
                    {lensViewMode === 'graph' ? (
                      <ul className="space-y-0.5 text-ink-muted">
                        <li><span className="font-medium text-ink">Click</span> a card — inspect it</li>
                        <li><span className="font-medium text-ink">Double-click</span> — focus there</li>
                        <li><span className="font-medium text-ink">⊕</span> on a card&apos;s outer edge — reveal or fetch its next hop</li>
                        <li><span className="font-medium text-ink">▸</span> beside a name — what is inside it</li>
                        <li><span className="font-medium text-ink">← / →</span> — step back / forward</li>
                        <li><span className="font-medium text-ink">Drag a card</span> — move it; connections follow</li>
                        <li><span className="font-medium text-ink">Drag · scroll</span> the background — pan and zoom</li>
                      </ul>
                    ) : (
                      <ul className="space-y-0.5 text-ink-muted">
                        <li><span className="font-medium text-ink">Click</span> a connection — re-center on it</li>
                        <li><span className="font-medium text-ink">← / →</span> — step back / forward</li>
                        <li><span className="font-medium text-ink">Hover</span> a row — reveal &amp; details actions</li>
                      </ul>
                    )}
                  </div>
                }
              >
                <button
                  type="button"
                  aria-label="How to explore"
                  className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                  <LucideIcons.HelpCircle className="w-4 h-4" />
                </button>
              </InfoTooltip>
              {/* Share this exploration — the walked path as a link (the
                  URL param restores it). */}
              <InfoTooltip side="bottom" content={shareCopied ? 'Link copied' : 'Copy a link to this exploration'}>
                <button
                  type="button"
                  data-tour="lens-share"
                  onClick={copyShareLink}
                  aria-label="Copy exploration link"
                  className={cn(
                    'w-7 h-7 rounded-md flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    shareCopied
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
                  )}
                >
                  {shareCopied ? <LucideIcons.Check className="w-4 h-4" /> : <LucideIcons.Link2 className="w-4 h-4" />}
                </button>
              </InfoTooltip>
              {/* What a container opens into, by default. Each frame can
                  still be flipped on its own; this sets the starting
                  point for the next one you open (persisted). */}
              {lensViewMode === 'graph' && (
                <div
                  data-tour="lens-children-mode"
                  role="group"
                  aria-label="What opened containers show"
                  className="flex items-center p-0.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04]"
                >
                  {([
                    { mode: 'connected', Icon: LucideIcons.Link2, label: 'Connected',
                      title: 'Opened containers show only what is on this lineage' },
                    { mode: 'all', Icon: LucideIcons.Rows3, label: 'All',
                      title: 'Opened containers show everything inside, with lineage marked where it exists' },
                  ] as const).map(({ mode, Icon, label, title }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setLensFrameChildren(mode)}
                      title={title}
                      aria-pressed={lensFrameChildren === mode}
                      className={cn(
                        'flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                        lensFrameChildren === mode
                          ? 'bg-canvas-elevated text-accent-lineage shadow-sm border border-black/[0.06] dark:border-white/[0.08]'
                          : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {/* Graph | List body toggle — the graph is the premium
                  default; the columns stay one click away (persisted). */}
              <div data-tour="lens-toggle" className="flex items-center p-0.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04]">
                <button
                  type="button"
                  onClick={() => setLensViewMode('graph')}
                  title="Graph — explore lineage interactively"
                  aria-pressed={lensViewMode === 'graph'}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    lensViewMode === 'graph'
                      ? 'bg-canvas-elevated text-accent-lineage shadow-sm border border-black/[0.06] dark:border-white/[0.08]'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  <LucideIcons.Network className="w-3 h-3" />
                  Graph
                </button>
                <button
                  type="button"
                  onClick={() => setLensViewMode('list')}
                  title="List — scan all connections as columns"
                  aria-pressed={lensViewMode === 'list'}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    lensViewMode === 'list'
                      ? 'bg-canvas-elevated text-accent-lineage shadow-sm border border-black/[0.06] dark:border-white/[0.08]'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  <LucideIcons.List className="w-3 h-3" />
                  List
                </button>
              </div>
              <div className="relative">
                <LucideIcons.Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/70" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter connections…"
                  className="w-48 pl-6 pr-7 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] border border-black/10 dark:border-white/10 text-[11.5px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear filter"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded flex items-center justify-center text-ink-muted/70 hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                  >
                    <LucideIcons.X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <LucideIcons.X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Path trail — the focus history as a visible, clickable
              path. Every visited hop is a chip; the cursor's chip is
              highlighted and hops AHEAD of the cursor stay visible
              (dimmed) — clicking any chip moves the cursor there
              without dropping the trail (browser history, not a
              destructive stack). ── */}
          {entries.length > 1 && onJumpTo && (
            <div className="flex items-center gap-1 px-4 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] overflow-x-auto custom-scrollbar whitespace-nowrap">
              <span className="flex-shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-muted/60 mr-1">
                Path
              </span>
              {(() => {
                // Middle-truncation window anchored on the CURSOR (not
                // the tail — after Back the tail is the forward side).
                let visible: number[]
                if (!collapseTrail) {
                  visible = entries.map((_, i) => i)
                } else {
                  const start = Math.max(1, cursor - 3)
                  const end = Math.min(entries.length - 1, cursor + 1)
                  visible = [0]
                  if (start > 1) visible.push(-1)
                  for (let i = start; i <= end; i++) visible.push(i)
                  if (end < entries.length - 1) visible.push(-2)
                }
                return visible.map((i, pos) => {
                  if (i === -1 || i === -2) {
                    const hidden = i === -1
                      ? entries.slice(1, Math.max(1, cursor - 3))
                      : entries.slice(Math.min(entries.length - 1, cursor + 1) + 1)
                    return (
                      <div key={i === -1 ? 'trail-gap' : 'trail-gap-fwd'} className="flex items-center gap-1 flex-shrink-0">
                        <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40" />
                        <button
                          type="button"
                          onClick={() => setShowFullTrail(true)}
                          title={`Show ${hidden.length} hidden hop${hidden.length === 1 ? '' : 's'}: ${hidden.map(labelFor).join(' → ')}`}
                          className="px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-dashed border-ink-muted/30 transition-colors"
                        >
                          … {hidden.length} hop{hidden.length === 1 ? '' : 's'}
                        </button>
                      </div>
                    )
                  }
                  const id = entries[i]
                  const isCurrent = i === cursor
                  const isForward = i > cursor
                  const label = labelFor(id)
                  const chipColor = generateColorFromType(
                    (sg.nodes.get(id)?.node?.data?.type as string) ?? 'entity',
                  )
                  const meta = i > 0 ? hopMeta[i - 1] : null
                  // Direction arrows only between ADJACENT hops — after a
                  // gap chip the transition shown isn't the real one.
                  const adjacent = pos > 0 && visible[pos - 1] === i - 1
                  // Parent context — "ticket_key · fact_support" — except
                  // when the previous hop already IS the parent.
                  const chipParent = parentOf(id)
                  const chipParentLabel = chipParent && chipParent !== entries[i - 1]
                    ? labelFor(chipParent)
                    : null
                  return (
                    <div key={`${id}-${i}`} className="flex items-center gap-1 flex-shrink-0">
                      {i > 0 && (
                        meta && adjacent ? (
                          <span
                            className="flex items-center"
                            title={`${meta.edgeType ? edgeLabelFor(meta.edgeType.toUpperCase(), edgeTypeInfo) : 'Connection'} — walked ${meta.downstream ? 'downstream' : 'upstream'}`}
                          >
                            {/* Amber is DOWNSTREAM everywhere else in the
                                lens — the band arrows, the focal's "out"
                                tally, the Data Consumers column. Sky
                                upstream, amber down. */}
                            {meta.downstream
                              ? <LucideIcons.MoveRight className={cn('w-3.5 h-3.5 text-amber-500/80', isForward && 'opacity-50')} />
                              : <LucideIcons.MoveLeft className={cn('w-3.5 h-3.5 text-sky-500/80', isForward && 'opacity-50')} />}
                          </span>
                        ) : (
                          <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/40" />
                        )
                      )}
                      <button
                        type="button"
                        disabled={isCurrent}
                        onClick={() => onJumpTo(i)}
                        title={`${isCurrent ? label : `Jump to ${label}`}${chipParentLabel ? ` — in ${chipParentLabel}` : ''}`}
                        className={cn(
                          isCurrent
                            ? 'flex items-center gap-1.5 max-w-[230px] px-2 py-0.5 rounded-md text-[11px] font-semibold text-accent-lineage bg-accent-lineage/12 border border-accent-lineage/30'
                            : 'flex items-center gap-1.5 max-w-[210px] px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-transparent transition-colors',
                          // The forward side of the history — where
                          // Forward leads — dimmed but fully clickable.
                          isForward && 'opacity-55 hover:opacity-100',
                        )}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: chipColor }} />
                        <span className="truncate">{label}</span>
                        {chipParentLabel && (
                          <span className="flex-shrink min-w-0 max-w-[90px] truncate text-[9px] font-normal text-ink-muted/60">
                            · {chipParentLabel}
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })
              })()}
              {/* The walked path (up to the cursor) as a deliverable:
                  present it on the canvas, or copy it as text. */}
              <div className="ml-auto flex items-center gap-1 pl-2 flex-shrink-0">
                {onShowPathOnCanvas && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onShowPathOnCanvas(entries.slice(0, cursor + 1)) }}
                    title="Frame this walked path on the canvas"
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
                  >
                    <LucideIcons.Frame className="w-3 h-3" />
                    Show on canvas
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // Parent-qualified hops (fact_support.ticket_key) so a
                    // pasted path carries full context; the qualifier is
                    // dropped when the previous hop already is the parent.
                    void navigator.clipboard?.writeText(
                      entries.slice(0, cursor + 1).map((id, idx, path) => {
                        const p = parentOf(id)
                        return p && p !== path[idx - 1]
                          ? `${labelFor(p)}.${labelFor(id)}`
                          : labelFor(id)
                      }).join(' → '),
                    )
                  }}
                  title="Copy this path as text (fact_support.ticket_key → System A → …)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <LucideIcons.Copy className="w-3 h-3" />
                  Copy path
                </button>
              </div>
            </div>
          )}

          {/* ── Walk narration — a failed or capped walk is SAID, never
              silently rendered as "no connections". ── */}
          {walkStatus === 'error' && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
              <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
              <span>
                Couldn&apos;t fetch this entity&apos;s lineage from the data source
                {walk?.error ? ` — ${walk.error}` : '.'}
              </span>
              <button
                type="button"
                onClick={retryWalk}
                className="ml-auto flex-shrink-0 font-semibold hover:underline"
              >
                Retry
              </button>
            </div>
          )}
          {walkStatus === 'done' && (model?.truncated || model?.seedTruncated) && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-ink-muted">
              <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
              <span>
                Large neighbourhood — the data source stopped early
                {model?.truncationReason ? ` (${model.truncationReason})` : ''}, so these counts are floors.
                Use ⊕ to walk further, or the filter to narrow.
              </span>
            </div>
          )}

          {/* ── Body — the SAME layout at every depth: re-centering
              swaps the focal in place instead of flipping to a
              different presentation. Two bodies, one model: the
              interactive hop-band GRAPH (default) or the classic
              two-column LIST, switched from the header toggle. ── */}
          {lensViewMode === 'graph' ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Type chips — an explicit, reversible filter, and hidden
                counts stay visible (never silent loss). */}
            {(typeChips.length > 1 || layout.hiddenByChips > 0) && (
              <div className="flex-shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 pb-1">
                {typeChips.length > 1 && (
                  <TypeChips chips={typeChips} hiddenTypes={hiddenTypes} onToggle={toggleHiddenType} />
                )}
                {layout.hiddenByChips > 0 && (
                  <span className="px-1.5 py-0.5 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[9.5px] text-ink-muted">
                    {layout.hiddenByChips} hidden by the type chips
                  </span>
                )}
              </div>
            )}
            <div data-tour="lens-graph" className="relative flex-1 min-h-0">
              <FocusGraphView
                graph={layout}
                focalId={nodeId}
                focalStats={{ in: inConnections, out: outConnections }}
                // 'unsupported' deliberately passes NOTHING: the
                // empty-direction whispers are a claim about what the
                // data source SAID, and it was never asked.
                focalFetch={walkStatus === 'unsupported' ? undefined : walkStatus}
                focalReach={reach}
                exportName={focalLabel}
                selectedId={view.selection}
                reducedMotion={reducedMotion}
                edgeTypeInfo={edgeTypeInfo}
                onSelect={setSelection}
                onFocus={onRecenter}
                onToggleFrame={toggleContents}
                onSetFramePage={setFramePage}
                onFrameQuery={setFrameQuery}
                frameQueryFor={frameQueryFor}
                onToggleFrameAll={toggleFrameAll}
                onRetryFrameAll={retryFrameAll}
                onRevealOnCanvas={onRevealOnCanvas}
                onOpenDetails={onOpenDetails}
                // The affordances only exist once the focal's own model
                // is in hand — `useLensWalk` ignores an extend before
                // that by design, so offering one would be a dead click.
                onRevealMore={walkStatus === 'done' ? revealMore : undefined}
                onExtend={walkStatus === 'done' ? extendWalk : undefined}
                onPage={walkStatus === 'done' ? pageWalk : undefined}
              />
              {/* Status surfaces — a lone focal card floating in space
                  explains nothing. */}
              {walkStatus === 'loading' && (
                <div className="absolute inset-x-0 bottom-8 z-10 flex justify-center pointer-events-none">
                  <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-canvas-elevated/95 border border-black/[0.07] dark:border-white/[0.08] shadow-sm text-[11px] text-ink-muted">
                    <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin text-accent-lineage/70" />
                    Walking the lineage from the data source…
                  </div>
                </div>
              )}
              {walkStatus === 'unsupported' && (
                <div className="absolute inset-x-0 bottom-8 z-10 flex justify-center pointer-events-none">
                  <div className="flex items-center gap-2 max-w-[520px] px-3.5 py-2 rounded-lg bg-canvas-elevated/95 border border-black/[0.07] dark:border-white/[0.08] shadow-sm text-[11px] text-ink-muted">
                    <LucideIcons.CircleSlash className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/50" />
                    This data source can&apos;t walk lineage — Focus mode needs a provider that
                    answers lineage queries.
                  </div>
                </div>
              )}
            </div>
            {/* ── Detail strip — single click inspects; focusing stays a
                deliberate second gesture. ── */}
            <AnimatePresence>
              {selectedInfo && (() => {
                const selColor = generateColorFromType(selectedInfo.type)
                return (
                  <motion.div
                    key={selectedInfo.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    transition={{ duration: reducedMotion ? 0 : 0.16, ease: 'easeOut' }}
                    className="flex items-center gap-3 px-4 py-2.5 border-t border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]"
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${selColor}1f` }}
                    >
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: selColor }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold text-ink leading-tight">
                        <span className="truncate">{selectedInfo.label}</span>
                        <span
                          className="flex-shrink-0 px-1.5 py-px rounded text-[8.5px] font-bold uppercase tracking-wide"
                          style={{ backgroundColor: `${selColor}1f`, color: selColor }}
                        >
                          {selectedInfo.type}
                        </span>
                      </p>
                      <p className="flex items-center gap-2 text-[10px] text-ink-muted leading-tight tabular-nums">
                        {selectedInfo.parentLabel && (
                          <span className="flex items-center gap-1 min-w-0">
                            <LucideIcons.FolderTree className="w-2.5 h-2.5 flex-shrink-0 text-ink-muted/60" />
                            <span className="truncate max-w-[180px]">{selectedInfo.parentLabel}</span>
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
                          <LucideIcons.ArrowDownLeft className="w-3 h-3" />
                          {selectedInfo.inCount} in
                        </span>
                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <LucideIcons.ArrowUpRight className="w-3 h-3" />
                          {selectedInfo.outCount} out
                        </span>
                        {selectedInfo.description && (
                          <span className="min-w-0 truncate max-w-[420px] italic text-ink-muted/70">
                            {selectedInfo.description}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => onRecenter(selectedInfo.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-lineage/15 border border-accent-lineage/40 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                      >
                        <LucideIcons.Focus className="w-3 h-3" />
                        Focus here
                      </button>
                      {onRevealOnCanvas && (
                        <button
                          type="button"
                          onClick={() => void onRevealOnCanvas(selectedInfo.id)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                        >
                          <LucideIcons.Crosshair className="w-3 h-3" />
                          Reveal on canvas
                        </button>
                      )}
                      {onOpenDetails && (
                        <button
                          type="button"
                          onClick={() => onOpenDetails(selectedInfo.id)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                        >
                          <LucideIcons.PanelRight className="w-3 h-3" />
                          Details
                        </button>
                      )}
                      {onTrace && (
                        <button
                          type="button"
                          onClick={() => { onClose(); onTrace(selectedInfo.id) }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                        >
                          <LucideIcons.GitBranch className="w-3 h-3" />
                          Trace
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelection(null)}
                        aria-label="Clear selection"
                        className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                      >
                        <LucideIcons.X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </motion.div>
                )
              })()}
            </AnimatePresence>
          </div>
          ) : (
          // minmax(0,1fr): a bare `1fr` track keeps min-width:auto, so a
          // long unbroken field name blows the track past the dialog
          // edge (no scroll → unusable). minmax(0,…) lets the track
          // shrink and the rows' `truncate` take over.
          <div className="flex-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] min-h-0">
            <NeighborColumn
              title="Data Sources"
              subtitle="Upstream"
              rows={neighbors.incoming.filter(filterFn)}
              totalConnections={inConnections}
              direction="incoming"
              walkStatus={walkStatus}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleHiddenType}
              searching={q !== ''}
              edgeTypeInfo={edgeTypeInfo}
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />

            {/* Focal card */}
            <div className="flex flex-col items-center justify-center px-5 py-6">
              <div className="flex items-center">
                <FlowRail color={focalColor} active={inConnections > 0} />
                <div
                  className="w-60 rounded-xl border-2 px-4 py-3.5 bg-canvas-elevated"
                  style={{
                    borderColor: focalColor,
                    background: `linear-gradient(150deg, ${focalColor}24, ${focalColor}08 60%)`,
                    boxShadow: `0 10px 34px ${focalColor}33`,
                  }}
                >
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] mb-1" style={{ color: focalColor }}>
                    {focalType}
                  </p>
                  {/* overflow-wrap:anywhere — `break-words` won't break an
                      unbroken run like a long snake_case field name, so it
                      would overflow the fixed-width card. */}
                  <p className="text-[15px] font-semibold text-ink [overflow-wrap:anywhere] leading-snug">{focalLabel}</p>
                  {/* Parent breadcrumb — where this entity LIVES; click
                      steps the lens up into the parent. */}
                  {focalParentId && (
                    <button
                      type="button"
                      onClick={() => onRecenter(focalParentId)}
                      title={`Re-center on ${focalParentLabel}`}
                      className="mt-0.5 flex items-center gap-1 max-w-full text-[10px] text-ink-muted hover:text-accent-lineage transition-colors"
                    >
                      <LucideIcons.CornerLeftUp className="w-2.5 h-2.5 flex-shrink-0" />
                      <span className="truncate">in {focalParentLabel}</span>
                    </button>
                  )}
                  <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-black/[0.07] dark:border-white/[0.08] text-[11px] font-medium tabular-nums">
                    <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
                      <LucideIcons.ArrowDownLeft className="w-3.5 h-3.5" />
                      {inConnections} in
                    </span>
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <LucideIcons.ArrowUpRight className="w-3.5 h-3.5" />
                      {outConnections} out
                    </span>
                  </div>
                  <ReachLine reach={reach} loading={walkStatus === 'loading'} />
                </div>
                <FlowRail color={focalColor} active={outConnections > 0} />
              </div>

              {/* Contained entities that are ON this lineage — the
                  descent that keeps exploration alive when a container's
                  relationships live at child level. */}
              {focalChildren.length > 0 && (
                <div className="w-60 mt-4 min-h-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <LucideIcons.FolderTree className="w-3 h-3 text-ink-muted/60" />
                    <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted/70">Contains</span>
                    <span className="text-[9.5px] tabular-nums text-ink-muted/60">
                      {focalChildren.length} on this lineage{focalChildTotal > focalChildren.length ? ` · of ${focalChildTotal}` : ''}
                    </span>
                  </div>
                  <div className="max-h-36 overflow-y-auto custom-scrollbar flex flex-col">
                    {focalChildren.slice(0, 50).map(cid => {
                      const cColor = generateColorFromType(
                        (sg.nodes.get(cid)?.node?.data?.type as string) ?? 'entity',
                      )
                      return (
                        <button
                          key={`focal-child-${cid}`}
                          type="button"
                          onClick={() => onRecenter(cid)}
                          title={`Step into ${labelFor(cid)} — walk its lineage`}
                          className="w-full min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-[11.5px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors"
                        >
                          <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-ink-muted/50" />
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cColor }} />
                          <span className="truncate">{labelFor(cid)}</span>
                          <LucideIcons.ChevronRight className="ml-auto w-3 h-3 flex-shrink-0 text-ink-muted/30" />
                        </button>
                      )
                    })}
                    {focalChildren.length > 50 && (
                      <p className="px-2 py-0.5 text-[10px] text-ink-muted/60">
                        +{(focalChildren.length - 50).toLocaleString()} more on this lineage
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <NeighborColumn
              title="Data Consumers"
              subtitle="Downstream"
              rows={neighbors.outgoing.filter(filterFn)}
              totalConnections={outConnections}
              direction="outgoing"
              walkStatus={walkStatus}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleHiddenType}
              searching={q !== ''}
              edgeTypeInfo={edgeTypeInfo}
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />
          </div>
          )}

          {/* ── Outside this view (feature-flagged preview) — partners
              that exist in the data source but are beyond this view's
              scope. The story is told explicitly: expected, not missing
              data, and NOT part of the canvas. Per-row CTA escalates to
              a Trace, the sanctioned way to pull external lineage in. ── */}
          {externalPreview && (externalPreview.loading || externalPreview.records.length > 0) && (
            <div className="px-4 py-2.5 border-t border-dashed border-sky-400/40 bg-sky-500/[0.05]">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.1em] uppercase text-sky-600 dark:text-sky-300">
                <LucideIcons.Unlink className="w-3 h-3" />
                <span>Outside this view</span>
                {externalPreview.loading ? (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <span className="tabular-nums normal-case tracking-normal text-sky-600/80 dark:text-sky-300/80">
                    {externalPreview.records.length} entit{externalPreview.records.length === 1 ? 'y' : 'ies'}
                  </span>
                )}
              </div>
              {!externalPreview.loading && (
                <div className="mt-1.5 grid grid-cols-2 gap-x-5 gap-y-1 max-h-36 overflow-y-auto custom-scrollbar">
                  {externalPreview.records.map(r => (
                    <div key={`${r.direction}-${r.urn}`} className="flex items-center gap-1.5 min-w-0 text-[11.5px]">
                      {r.direction === 'in'
                        ? <LucideIcons.ArrowDownLeft className="w-3 h-3 flex-shrink-0 text-sky-500/80" />
                        : <LucideIcons.ArrowUpRight className="w-3 h-3 flex-shrink-0 text-sky-500/80" />}
                      <span className="truncate text-ink">{r.label}</span>
                      {r.edgeType && (
                        <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-ink-muted/50">{r.edgeType}</span>
                      )}
                      {onTrace && (
                        <InfoTooltip side="top" content={`Trace lineage from ${r.label} — brings its lineage onto the canvas`}>
                          <button
                            type="button"
                            onClick={() => { onClose(); onTrace(r.urn) }}
                            className="ml-auto flex-shrink-0 rounded text-[10px] font-semibold text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                          >
                            Trace
                          </button>
                        </InfoTooltip>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-[10px] text-ink-muted/60 italic leading-snug">
                These connections exist in the data source but their entities aren&apos;t part of this
                view — expected for a curated subset, not missing data. This is a preview; nothing has
                been added to the canvas.
              </p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-black/[0.08] dark:border-white/[0.08]">
            <p className="text-[10.5px] text-ink-muted/80">
              {lensViewMode === 'graph'
                ? 'Click a card to inspect · ⊕ to walk a hop · ▸ to open what is inside · Double-click to focus · Esc to close'
                : 'Click a connection to re-center · Esc to close'}
            </p>
            <div className="ml-auto flex items-center gap-2">
              {onLocateAll && (
                <button
                  type="button"
                  onClick={() => {
                    const ids = [...new Set([...neighbors.incoming, ...neighbors.outgoing].map(r => r.urn))]
                    onClose()
                    void onLocateAll(ids)
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                  <LucideIcons.Frame className="w-3 h-3" />
                  Reveal all on canvas
                </button>
              )}
              {onTrace && (
                <button
                  type="button"
                  onClick={() => { onClose(); onTrace(nodeId) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-lineage/15 border border-accent-lineage/40 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                  <LucideIcons.GitBranch className="w-3 h-3" />
                  Trace from here
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

/**
 * How far the walk has reached, on the focal card.
 *
 * Two counts and one qualifier — and the qualifier is the honest half:
 * a walk that still has an open frontier has seen SOME of the lineage,
 * so the numbers are floors and say so. The old strip measured a
 * bounded transitive trace of its own, which counted different things
 * from everything beside it and could not be reconciled with them.
 */
function ReachLine({ reach, loading }: { reach: LensReach | null; loading: boolean }) {
  if (loading) {
    return (
      <p className="flex items-center gap-1.5 mt-1.5 text-[10px] text-ink-muted/70">
        <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/60" />
        Walking the lineage…
      </p>
    )
  }
  if (!reach) return null
  return (
    <p
      className="flex items-center gap-1.5 mt-1.5 text-[10px] text-ink-muted tabular-nums"
      title={reach.more
        ? 'Entities this walk has reached so far. More exists beyond this view — use ⊕ on a card to walk further.'
        : 'Every entity connected to this one, upstream and downstream, as far as the data source goes.'}
    >
      <LucideIcons.Radar className="w-3 h-3 text-accent-lineage/70" />
      <span>
        Reach: {reach.up.toLocaleString()} upstream · {reach.down.toLocaleString()} downstream
        {reach.more ? ' · more beyond this view' : ''}
      </span>
    </p>
  )
}

/** Short horizontal flow rail flanking the focal card — reads as the
 *  edge entering / leaving the focal entity. */
function FlowRail({ color, active }: { color: string; active: boolean }) {
  if (!active) return <div className="w-6" />
  return (
    <div className="flex items-center w-6">
      <div className="h-[2px] flex-1 rounded-full" style={{ background: `linear-gradient(to right, ${color}22, ${color}aa)` }} />
      <LucideIcons.ChevronRight className="w-3 h-3 -ml-1 flex-shrink-0" style={{ color }} />
    </div>
  )
}

/** Entity-type filter chips. An OFF chip goes ghost (dashed border,
 *  dimmed, EyeOff) but keeps its count: filtering is an explicit,
 *  visible, reversible choice — never a strikethrough that reads as
 *  broken, never silent loss. */
function TypeChips({
  chips,
  hiddenTypes,
  onToggle,
  className,
}: {
  chips: Array<[string, number]>
  hiddenTypes: ReadonlySet<string>
  onToggle: (type: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map(([t, n]) => {
        const off = hiddenTypes.has(t)
        const chipColor = t === 'not loaded' ? '#94a3b8' : generateColorFromType(t)
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggle(t)}
            title={off
              ? `${t} hidden — click to show these ${n} entit${n === 1 ? 'y' : 'ies'} again`
              : `Click to hide ${t} entities (${n})`}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide transition-all',
              off
                ? 'border-dashed border-ink-muted/30 text-ink-muted/45 hover:text-ink-muted hover:border-ink-muted/50'
                : 'border-black/10 dark:border-white/10 text-ink-muted hover:text-ink bg-black/[0.03] dark:bg-white/[0.04]',
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: chipColor, opacity: off ? 0.3 : 1 }} />
            <span className="max-w-[90px] truncate">{t}</span>
            <span className="tabular-nums">{n}</span>
            {off && <LucideIcons.EyeOff className="w-2.5 h-2.5 flex-shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}

/** One neighbour row — the same entity the graph body draws as a card,
 *  with the same weight on it. */
function NeighborRow({
  r,
  isIn,
  edgeTypeInfo,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  r: WalkNeighbor
  isIn: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  const accentColor = r.type === 'not loaded' ? '#94a3b8' : generateColorFromType(r.type)
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        // content-visibility skips layout+paint for offscreen rows —
        // lightweight virtualization; columns can hold hundreds of rows.
        // transition-colors (not -all): animating every property makes
        // hover sweeps during scroll recompute layout per row.
        'group relative flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_58px] border-black/[0.07] dark:border-white/[0.08] hover:border-accent-lineage/50 hover:shadow-sm bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
      onClick={() => onRecenter(r.urn)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRecenter(r.urn) } }}
      title={`Re-center on ${r.label}`}
    >
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 min-w-0 text-[12px] font-medium text-ink leading-snug">
          <span className="truncate">{r.label}</span>
        </p>
        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug">
          <span
            className="truncate uppercase tracking-wide"
            title={edgeTypeInfo?.get(r.edgeTypeNorm)?.description}
          >
            {r.edgeTypeNorm ? edgeLabelFor(r.edgeTypeNorm, edgeTypeInfo) : 'several relationships'}
          </span>
          {r.weight > 1 && (
            <span className="tabular-nums font-semibold text-ink-muted" title={`${r.weight} connections`}>
              ×{r.weight.toLocaleString()}
            </span>
          )}
        </p>
      </div>
      {/* Flow direction cue: data always travels left → right. Hover
          actions ALWAYS dock on the right (docking them left covered
          the label/chevron); only the right-side chevron (incoming
          rows) swaps out for them. */}
      <LucideIcons.ChevronRight
        className={cn('w-3.5 h-3.5 flex-shrink-0 text-ink-muted/50', isIn ? 'order-last group-hover:hidden' : 'order-first')}
      />
      <span className="hidden group-hover:flex flex-shrink-0 order-last items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5">
        {onRevealOnCanvas && (
          <InfoTooltip side="top" content="Reveal on canvas">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void onRevealOnCanvas(r.urn) }}
              className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.Crosshair className="w-3 h-3" />
            </button>
          </InfoTooltip>
        )}
        {onOpenDetails && (
          <InfoTooltip side="top" content="Open details">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenDetails(r.urn) }}
              className="w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.PanelRight className="w-3 h-3" />
            </button>
          </InfoTooltip>
        )}
      </span>
    </div>
  )
}

/**
 * One direction's neighbours as a scannable column.
 *
 * Grouped by their containment PARENT when the walk knows one — the
 * column then reads "which datasets feed me, via which fields", which
 * is the structural story the graph body tells by nesting.
 */
function NeighborColumn({
  title,
  subtitle,
  rows,
  totalConnections,
  direction,
  walkStatus,
  hiddenTypes,
  onToggleType,
  searching,
  edgeTypeInfo,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  title: string
  subtitle: string
  rows: WalkNeighbor[]
  totalConnections: number
  direction: 'incoming' | 'outgoing'
  walkStatus: LensFetchStatus
  hiddenTypes: ReadonlySet<string>
  onToggleType: (type: string) => void
  /** Text filter active — every group expands so matches can't hide
   *  inside a collapsed one (that would be silent loss). */
  searching: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  const { typeChips, groups, hiddenCount } = useMemo(() => {
    const typeCounts = new Map<string, number>()
    for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1)
    const typeChips = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
    let hiddenCount = 0
    const shown: WalkNeighbor[] = []
    for (const r of rows) {
      if (hiddenTypes.has(r.type)) { hiddenCount++; continue }
      shown.push(r)
    }
    const groupMap = new Map<string, { key: string; label: string; rows: WalkNeighbor[] }>()
    for (const r of shown) {
      const mapKey = r.parentUrn ? `p:${r.parentUrn}` : `t:${r.type}`
      let g = groupMap.get(mapKey)
      if (!g) {
        g = { key: r.parentUrn ?? r.type, label: r.parentLabel ?? r.type, rows: [] }
        groupMap.set(mapKey, g)
      }
      g.rows.push(r)
    }
    const groups = [...groupMap.values()].sort((a, b) => b.rows.length - a.rows.length)
    return { typeChips, groups, hiddenCount }
  }, [rows, hiddenTypes])

  const isIn = direction === 'incoming'
  const allFilteredOff = rows.length > 0 && groups.length === 0

  return (
    <div className={cn(
      // min-w-0: allow the grid track to shrink so long labels truncate
      // instead of forcing the column (and dialog) wider than the viewport.
      'flex flex-col min-h-0 min-w-0',
      isIn
        ? 'border-r border-black/[0.07] dark:border-white/[0.07]'
        : 'border-l border-black/[0.07] dark:border-white/[0.07]',
    )}>
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-shrink-0">
        {isIn
          ? <LucideIcons.ArrowDownLeft className="w-3.5 h-3.5 text-sky-500" />
          : <LucideIcons.ArrowUpRight className="w-3.5 h-3.5 text-amber-500" />}
        <span className="text-[11.5px] font-semibold text-ink">{title}</span>
        <span className="text-[10px] text-ink-muted">{subtitle}</span>
        <span className={cn(
          'ml-auto px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums',
          isIn
            ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        )}>
          {totalConnections}
        </span>
      </div>
      {typeChips.length > 1 && (
        <TypeChips chips={typeChips} hiddenTypes={hiddenTypes} onToggle={onToggleType} className="px-3 pb-1.5 flex-shrink-0" />
      )}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 pb-3">
        {allFilteredOff && (
          <p className="px-2 py-6 text-center text-[11px] text-ink-muted/70 leading-snug">
            All {rows.length} hidden by the type chips above.
          </p>
        )}
        {rows.length === 0 && (
          walkStatus === 'loading' ? (
            <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <LucideIcons.Loader2 className="w-5 h-5 animate-spin text-accent-lineage/60" />
              <p className="text-[11px] text-ink-muted/70 leading-snug">
                Walking {isIn ? 'upstream sources' : 'downstream consumers'} from the data source…
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <LucideIcons.CircleSlash className="w-5 h-5 text-ink-muted/40" />
              <p className="text-[11px] text-ink-muted/70 leading-snug">
                {searching
                  ? 'No matches for this filter'
                  : walkStatus === 'done'
                    // Post-walk this is a claim about the DATA SOURCE.
                    ? `No ${isIn ? 'upstream sources' : 'downstream consumers'} in the data source`
                    : walkStatus === 'unsupported'
                      ? 'This data source can’t walk lineage'
                      : `Couldn’t reach the data source for ${isIn ? 'upstream sources' : 'downstream consumers'}`}
              </p>
            </div>
          )
        )}
        {groups.map(g => (
          <NeighborGroup
            key={g.key}
            group={g}
            isIn={isIn}
            direction={direction}
            searching={searching}
            groupCount={groups.length}
            edgeTypeInfo={edgeTypeInfo}
            onRecenter={onRecenter}
            onRevealOnCanvas={onRevealOnCanvas}
            onOpenDetails={onOpenDetails}
          />
        ))}
        {hiddenCount > 0 && !allFilteredOff && (
          <p className="px-2 py-1.5 text-[10px] text-ink-muted/60">
            {hiddenCount} hidden by the type chips
          </p>
        )}
      </div>
    </div>
  )
}

/** One parent group — collapsible, because 3+ of them means the useful
 *  first read is "which datasets feed me", not every field at once. */
function NeighborGroup({
  group,
  isIn,
  direction,
  searching,
  groupCount,
  edgeTypeInfo,
  onRecenter,
  onRevealOnCanvas,
  onOpenDetails,
}: {
  group: { key: string; label: string; rows: WalkNeighbor[] }
  isIn: boolean
  direction: 'incoming' | 'outgoing'
  searching: boolean
  groupCount: number
  edgeTypeInfo?: EdgeTypeInfoMap
  onRecenter: (nodeId: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
}) {
  // 3+ groups → start collapsed (dataset-level overview first); the
  // toggle XORs that default so it never needs migrating. Searching
  // expands everything.
  const [toggled, setToggled] = useState(false)
  const collapsed = !searching && (groupCount >= 3) !== toggled
  const parentColor = generateColorFromType(group.rows[0]?.type ?? 'entity')
  return (
    <div className="mb-2.5">
      <div className="flex items-center gap-1 mb-1 min-w-0">
        <button
          type="button"
          onClick={() => setToggled(t => !t)}
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${group.rows.length} connection${group.rows.length === 1 ? '' : 's'}` : 'Collapse group'}
          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-left bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.07] transition-colors"
        >
          <LucideIcons.ChevronDown className={cn('w-4 h-4 flex-shrink-0 text-ink-muted transition-transform', collapsed && '-rotate-90')} />
          <LucideIcons.FolderTree className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/70" />
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: parentColor }} />
          <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{group.label}</span>
          <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-[10px] font-semibold tabular-nums text-ink-muted">
            {group.rows.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onRecenter(group.key)}
          title={`Re-center on ${group.label}`}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
        >
          <LucideIcons.Crosshair className="w-3.5 h-3.5" />
        </button>
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-1">
          {group.rows.map(r => (
            <NeighborRow
              key={`${direction}-${r.urn}`}
              r={r}
              isIn={isIn}
              edgeTypeInfo={edgeTypeInfo}
              onRecenter={onRecenter}
              onRevealOnCanvas={onRevealOnCanvas}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </div>
      )}
    </div>
  )
}
