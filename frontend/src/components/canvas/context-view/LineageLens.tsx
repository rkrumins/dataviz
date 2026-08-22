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
import type { WalkEntry, LensWalkDir, WalkProgress } from '@/hooks/useLensWalk'
import { emptyWalkModel, type LensWalkNode } from './lens/closure-adapter'
import { accountedLineageEdges } from './lens/rollup-accounting'
import { rollupResiduals } from '@/hooks/lib/traceWireLedger'
import {
  boundaryFrontierFilter,
  hopWeight,
  buildLensSubgraph,
  distinctSystemCount,
  rootUrnOf,
  type LensSubgraph,
} from './lens/lens-subgraph'
import {
  buildFocusLayout,
  revealKey,
  viewStateForTransition,
  initialLensViewState,
  type LensDirectionFilter,
  type LensFetchStatus,
  type LensRoster,
  type LensViewState,
  type LensViewTransitionKind,
} from './lens/focus-layout'
import { applyCondensation } from './lens/condensation'
import { enforceLensInvariants } from './lens/invariants'
import { generateColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'
import { useTourStore } from '@/features/tour/tourStore'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { lensFocalOf, lensTransitionKind, type LensHistory } from './lens/lensHistory'
import { labelOf, edgeLabelFor, orientationHalf, FRAME_WINDOW_ALL, type EdgeTypeInfoMap, type LensReach, type LensNeighbor } from './lens/focus-cards'
import { encodeLensShare } from './lens/shareCodec'
import { FocusGraphView } from './lens/FocusGraphView'
import { TraceWalkIndicator } from './TraceWalkIndicator'
import type { ReactNode } from 'react'
import { ControlTip } from './lens/ControlTip'
import { useToolbarOverflow } from './lens/useToolbarOverflow'
import { ViewControl } from './lens/ViewControl'
import * as Popover from '@radix-ui/react-popover'
import { LensSkeleton } from './lens/LensSkeleton'

/** Leaves one ⊕ extend ships to the server. A hub can stand for
 *  thousands of participants; the request has to stay a request. */
const SEED_CAP = 500
/** Every node of a subgraph that carries a real name, folded into `prev`. */
function rememberNames(sg: LensSubgraph<LensWalkNode>, prev: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  let names: Map<string, string> | null = null
  for (const [urn, entry] of sg.nodes) {
    const data = entry.node?.data as { label?: string; businessLabel?: string } | undefined
    const label = data?.label ?? data?.businessLabel
    if (!label || prev.get(urn) === label) continue
    names ??= new Map(prev)
    names.set(urn, label)
  }
  return names ?? prev
}
/** The capsule's decision buttons never render on the Lens (checkpoint and
 *  error keep their strips), but the props are required. */
const noop = () => {}
/** The header's segmented groups, most important first: what stays on
 *  the row longest as it narrows. The day-to-day controls — which side
 *  of the story, how much of the picture is folded, how the wires draw
 *  — stay in reach; Walk changes the question less often; Steps and
 *  Next are settings, and fold first. */
const TOOLBAR_ORDER = ['direction', 'density', 'wires', 'walk', 'steps', 'next'] as const
type ToolbarGroupId = (typeof TOOLBAR_ORDER)[number]
const EMPTY_TYPE_SET: ReadonlySet<string> = new Set()
const EMPTY_EXTEND_STATUS: ReadonlyMap<string, 'loading' | 'error'> = new Map()
const EMPTY_ROSTERS: ReadonlyMap<string, LensRoster> = new Map()
const EMPTY_ROSTER_STATUS: ReadonlyMap<string, LensFetchStatus> = new Map()

/**
 * One hop-1 neighbour of an anchor, as the walk model reports it — the
 * same edges the graph body draws, counted the same way, so the two
 * bodies cannot disagree about what is connected. `LensNeighbor`
 * (focus-cards.ts) is this same shape plus its containment ROOT — the
 * list body's own "system" grouping.
 */
type WalkNeighbor = LensNeighbor

/**
 * An anchor's direct neighbours, straight off the walk model —
 * `sg.focusUrn` for the focal's own orientation sentence, or any other
 * urn — the list body's own neighbour rows (and, historically, the
 * not necessarily the focal's own).
 *
 * "Hop 1" is structural: a lineage edge with one endpoint on the ANCHOR
 * SIDE (the anchor plus everything contained in it — a container has no
 * edges of its own, only its descendants do) and the other outside it.
 * That is exactly the rule `buildLensSubgraph` uses to number hops from
 * the FOCUS, generalized here to any anchor so a triage list opened on a
 * frame's own ⊕ counts the same way that frame's badge already does.
 *
 * Exported so the harness (`buildWalk.ts`) can build a triage-list shot
 * through the SAME function `partnersFor` calls in production, rather
 * than a second copy that could quietly drift from it.
 */
/** The focus SIDE: the focus and everything inside it — hop 0, never a
 *  partner, whichever surface is counting. */
function focusSideOf(sg: LensSubgraph<LensWalkNode>, anchorUrn: string = sg.focusUrn): Set<string> {
  const focusSide = new Set<string>()
  const stack = [anchorUrn]
  while (stack.length > 0) {
    const urn = stack.pop()!
    if (focusSide.has(urn) || !sg.nodes.has(urn)) continue
    focusSide.add(urn)
    for (const child of sg.nodes.get(urn)!.children) stack.push(child)
  }
  return focusSide
}

// eslint-disable-next-line react-refresh/only-export-components
export function walkNeighborRecords(sg: LensSubgraph<LensWalkNode>, anchorUrn: string = sg.focusUrn): {
  incoming: WalkNeighbor[]
  outgoing: WalkNeighbor[]
} {
  const focusSide = focusSideOf(sg, anchorUrn)

  const build = (dir: 'in' | 'out'): WalkNeighbor[] => {
    const byUrn = new Map<string, { weight: number; types: Set<string> }>()
    for (const hop of sg.lineageEdges) {
      const near = dir === 'in' ? hop.targetUrn : hop.sourceUrn
      const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
      if (!focusSide.has(near) || focusSide.has(far)) continue
      const entry = byUrn.get(far) ?? { weight: 0, types: new Set<string>() }
      entry.weight += hopWeight(hop)
      entry.types.add((hop.edgeType ?? '').toUpperCase())
      byUrn.set(far, entry)
    }
    const labelFor = (urn: string) => labelOf(urn, sg.nodes.get(urn)?.node)
    return [...byUrn.entries()]
      .map(([urn, { weight, types }]) => {
        const node = sg.nodes.get(urn)
        const parentUrn = node?.parent ?? null
        // T23 R3 — the containment ROOT, not just the immediate parent:
        // "grouped by system" reads the same "system" the orientation
        // sentence's own "across N systems" already means
        // (`distinctSystemCount`), not whatever frame happens to be one
        // level up.
        const systemUrn = rootUrnOf(sg, urn)
        return {
          urn,
          label: labelFor(urn),
          type: (node?.node?.data?.type as string) ?? node?.node?.entityType ?? 'not loaded',
          weight,
          edgeTypeNorm: types.size === 1 ? [...types][0] : '',
          parentUrn,
          parentLabel: parentUrn ? labelFor(parentUrn) : null,
          systemUrn,
          systemLabel: systemUrn === urn ? labelFor(urn) : labelFor(systemUrn),
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
  // THE BOUNDARY RULE, the same call the ⊕ counts by, so the seeds and
  // the badge can never disagree. Focus-relative, exactly like the badge:
  // a partner card's members all sit outside the focus and are seeded as
  // they always were; the FOCAL's are seeded only where the picture has
  // seen them reach out of the focus. Seeded from the rest, a container's
  // extend re-asks for its own inside — every one of those urns is
  // already held and excluded, so the fetch returns nothing and the click
  // delivers nothing (reported live: Snowflake's "+211").
  const offers = boundaryFrontierFilter(sg, sg.focusUrn, dir)
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
    if ((degree > 0 || frontier != null) && offers(urn)) members.push({ urn, degree })
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
  /** Re-kick a failed INITIAL fetch. A failed extend needs no twin:
   *  retrying one is the same click on the same pill, so the ⊕ simply
   *  calls `extend` again and the two can never drift apart. */
  retry: (focusUrn: string) => void
  /** Page the FOCUS's own capped contents (the model's seedCursor). The
   *  walk hook does this by itself now; kept optional so older hosts keep
   *  compiling. */
  pageSeeds?: (focusUrn: string) => void
}

/**
 * A restored exploration, applied ONCE to the focal it names — decoded
 * from a share v2 token (see shareCodec.ts). `revealed`/`opened`/
 * `collapsed`/`frameAll`/`framePages`/`frameQueries` are exactly a
 * `LensViewState`'s own fields (`framePages` keeps the wire name it was
 * minted with and is read as `frameOffsets` — see the codec's own note);
 * a revealed key whose card never lands in
 * the fetched model simply no-ops under the population fixpoint — the
 * same safety `buildFocusLayout` already gives a stale key, so a seed
 * can never reach outside the walk it is applied to. Frontier EXTENDS
 * are deliberately not encoded (they cost a round trip); the restored
 * board just shows their honest pills instead of replaying the fetch. */
export interface LensWalkSeed {
  /** Applied once this exact focal's walk entry reaches 'done'. */
  nodeId: string
  direction: LensDirectionFilter
  revealed: Array<[string, number]>
  opened: string[]
  collapsed: string[]
  frameAll: string[]
  framePages: Array<[string, number]>
  frameQueries: Array<[string, string]>
  /** T23 R3 — placements from a v3 share link; `[]` for a v2 one (it
   *  predates hub triage). */
  pinned: string[]
  /** T23 R2 — unfolded connector ids from a v3 share link; `[]` for a v2
   *  one (it predates condensation, so nothing was ever folded to begin
   *  with — every run just opens condensed, as it always does). */
  condensedOpen: string[]
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
  /** A shared exploration to restore, once. Applied to the focal it
   *  names the moment that focal's walk lands (see LensWalkSeed). */
  walkSeed?: LensWalkSeed | null
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
  /** Place a whole set on the canvas behind the lens. Its only footer
   *  button was withdrawn (see the Footer below); the prop stays on the
   *  contract so bringing it back needs no re-plumbing. */
  onLocateAll?: (nodeIds: string[]) => void | Promise<void>
  /** Escalate to a full server trace from the focal node (closes the lens). */
  onTrace?: (nodeId: string) => void
  /** The walk completes HANDS-FREE in both modes (2026-08-21); the lens
   *  only SAYS where it stands — the immediate lineage loading, the full
   *  flow walking, complete — and offers the two valves: the one-time
   *  memory checkpoint ("Continue") and a retry for failed steps. Absent =
   *  the feature is not wired, nothing renders. */
  fullWalkEnabled?: boolean
  walkProgress?: WalkProgress | null
  /** A name the canvas that opened the lens knows for a URN, or null. Read
   *  only for nodes no model in hand carries — the focus before its first
   *  page lands (so the header and the capsule never open on a URN
   *  fragment), and a Path stop the lens never drew (a restored link). */
  labelHintFor?: (urn: string) => string | null
  /** Switch between One hop (the focus's immediate lineage, then ⊕ walking)
   *  and Full flow. */
  onFullWalkToggle?: (on: boolean) => void
  /** Lift the one-time memory checkpoint. */
  onWalkContinue?: () => void
  /** Give failed walk steps one more attempt. */
  onWalkRetry?: () => void
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
  walkSeed = null,
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
  onTrace,
  fullWalkEnabled = false,
  walkProgress = null,
  labelHintFor,
  onFullWalkToggle,
  onWalkContinue,
  onWalkRetry,
  externalPreview,
}: LineageLensProps) {
  const { entries, cursor } = history
  const nodeId = lensFocalOf(history)
  const canBack = cursor > 0
  const canForward = cursor < entries.length - 1

  // T26 R1 — which of the five in-session transition kinds produced the
  // CURRENT `history`, purely from comparing it against the previous
  // render's (`lensTransitionKind`, lensHistory.ts — pure history-shape
  // classification, unit-tested on its own). The React-sanctioned
  // "adjust state during rendering" pattern (react.dev, "Adjusting some
  // state when a prop changes"): a plain conditional `setState` call in
  // the render body itself, never an effect — so it can never lag a
  // tick behind `nodeId` (React re-renders immediately, before
  // committing, whenever this branch fires) and is idempotent across a
  // StrictMode double-render or any re-render where `history` did not
  // change (the branch only fires when the reference actually differs).
  const [transitionTrack, setTransitionTrack] = useState<{ history: LensHistory; kind: LensViewTransitionKind }>(
    () => ({ history, kind: 'lens-open' }),
  )
  // Computed fresh for THIS render (not read back off `transitionTrack`,
  // which will not reflect the `setTransitionTrack` call below until
  // React's own immediate re-render) — see the pattern's own citation
  // above for why reading state written this same render is stale.
  let transitionKind = transitionTrack.kind
  if (transitionTrack.history !== history) {
    transitionKind = lensTransitionKind(transitionTrack.history, history)
    setTransitionTrack({ history, kind: transitionKind })
  }

  // Query is keyed to the focal node — re-centering starts with a fresh
  // filter without needing a reset effect.
  const [queryState, setQueryState] = useState<{ nodeId: string | null; q: string }>({ nodeId: null, q: '' })
  const query = queryState.nodeId === nodeId ? queryState.q : ''
  const setQuery = (q: string) => setQueryState({ nodeId, q })

  const walkStatus: LensFetchStatus = walk?.status ?? 'loading'
  // What the board's capsule narrates: the driver's phase while it is
  // computing (plus `done`, for the capsule's own finished beat), or the
  // bare fetch status before the driver has an entry for this focus.
  // Checkpoint and error are strips, not a capsule.
  const capsulePhase: WalkProgress['phase'] | null = walkProgress
    ? (walkProgress.phase === 'checkpoint' || walkProgress.phase === 'error' ? null : walkProgress.phase)
    : walkStatus === 'loading' ? 'loading' : null
  const model = walk?.model ?? null

  // THE TOOLBAR's overflow: measured, never guessed — see useToolbarOverflow.
  const toolbarRowRef = useRef<HTMLDivElement | null>(null)
  const { collapsed: collapsedGroups, registerGroup } = useToolbarOverflow(toolbarRowRef, TOOLBAR_ORDER)
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false)


  // ── The pipeline: model → subgraph → view state → layout ──────────

  // THE COARSE FIRST PAINT (Part G): when the model holds rollup cells the
  // board is built from the ACCOUNTED edges — every raw hop, plus only the
  // cells that still say something once the cells and raw hops inside them
  // have spoken, each weighted by what it says. Once the walk is done every
  // raw-backed cell is dropped: raw evidence wins. The direction flags take
  // the coarse partners too, so a side reads as present from the first paint.
  const walkDone = walkProgress?.phase === 'done' || walkProgress == null
  const sg = useMemo(() => {
    const base = model ?? emptyWalkModel(nodeId ?? '')
    return buildLensSubgraph({
      ...base,
      lineageEdges: accountedLineageEdges(base, { vouchAll: walkDone }),
      upstreamUrns: new Set([...base.upstreamUrns, ...(base.coarseUpstreamUrns ?? [])]),
      downstreamUrns: new Set([...base.downstreamUrns, ...(base.coarseDownstreamUrns ?? [])]),
    })
  }, [model, nodeId, walkDone])

  // T26 R1 — what a fresh transition to THIS focal should show, per
  // `viewStateForTransition` (focus-layout.ts), the single owner of
  // every `LensViewState` field's disposition across a transition.
  // Recomputed only when the model or the transition kind changes, so
  // it is a stable identity for the layout memo below. No `prev` to
  // offer: none of the five in-session kinds reads it (T25-C2's own
  // finding — a transition resets every field fresh), and threading
  // `viewState` through here would recompute this on every in-view
  // edit, not just a transition.
  // Subscribed HERE (before its later siblings) because the fresh view
  // consumes it: the Contents preference decides whether a focal opens
  // showing its whole roster or only its flow rows.
  const lensFrameChildren = usePreferencesStore((s) => s.lensFrameChildren)
  const freshView = useMemo(
    () => viewStateForTransition(transitionKind, null, { sg }, lensFrameChildren),
    [sg, transitionKind, lensFrameChildren],
  )
  const [viewState, setViewState] = useState<{ nodeId: string | null; view: LensViewState } | null>(null)
  // Discarded on re-center, exactly like the filter and chip state: a
  // new focal is a new question, not a continuation of this one — EXCEPT
  // for a one-time seed restored from a share link (below), which is the
  // sanctioned way a focal's starting view can be anything but default.
  //
  // T25 C2, invariant (b) — the answer to "does an ORDINARY in-session
  // re-anchor (double-click / Focus-here / breadcrumb — every path runs
  // through `ctx.onFocus` → the `onRecenter` prop → `lensPush`, one
  // shared mechanism) actually reset `condensedOpen`/`pinned`, or does
  // it take some OTHER path where they never reset?" It is NOT the
  // walkSeed-restoration effect below — that is a SEPARATE, one-time
  // mechanism that only ever fires for a restored SHARE LINK, and an
  // ordinary re-anchor never touches it. The reset here is this plain
  // derived value, re-evaluated on EVERY render, with no effect and no
  // async gap in between: the moment `nodeId` changes,
  // `viewState?.nodeId === nodeId` is false on THIS SAME render, so
  // `view` falls back to a fresh `freshView` atomically — there is no
  // tick where a stale value from the old focal is live under the new
  // one. See
  // `LineageLens.test.tsx`'s "re-anchoring from a walked-through state"
  // describe block for the pin walking this exact in-session path.
  const view = viewState?.nodeId === nodeId ? viewState.view : freshView
  const editView = useCallback((edit: (base: LensViewState) => LensViewState) => {
    setViewState(prev => ({
      nodeId,
      view: edit(prev?.nodeId === nodeId ? prev.view : freshView),
    }))
  }, [nodeId, freshView])

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

  // Direction preset — VIEW-SIDE filter (the fetch always stays 'both';
  // see focus-layout.ts's `directionFilter`). Per-focal like the other
  // lens-local state above, so re-centering starts at "Both" again.
  const [directionState, setDirectionState] = useState<{ nodeId: string | null; dir: LensDirectionFilter }>({ nodeId: null, dir: 'both' })
  const directionFilter = directionState.nodeId === nodeId ? directionState.dir : 'both'
  const setDirectionFilter = (dir: LensDirectionFilter) => setDirectionState({ nodeId, dir })

  const lensViewMode = usePreferencesStore((s) => s.lensViewMode)
  // Bumped by the header's Center on focus; the board centres on it.
  const [recenterSignal, setRecenterSignal] = useState(0)
  const setLensFrameChildren = usePreferencesStore((s) => s.setLensFrameChildren)
  const condenseSteps = usePreferencesStore((s) => s.lensCondenseSteps)
  const setCondenseSteps = usePreferencesStore((s) => s.setLensCondenseSteps)
  // Part H — how much of the picture is FOLDED: the reader's own grain.
  const density = usePreferencesStore((s) => s.lensDensity)
  const wires = usePreferencesStore((s) => s.lensWires)
  const setWires = usePreferencesStore((s) => s.setLensWires)
  const setDensity = usePreferencesStore((s) => s.setLensDensity)
  const lensInitialDepth = usePreferencesStore((s) => s.lensInitialDepth)
  const reducedMotion = usePreferencesStore((s) => s.reducedMotion)

  // Restore a shared exploration — ONCE, the moment the seed's own focal
  // is the one on screen AND its walk has actually landed (a revealed key
  // means nothing until the model it points into exists). Guarded by a
  // ref rather than folded into the nodeId-keyed state above: THAT state
  // is keyed to "whichever focal is current" and rebuilding it on every
  // walk-status tick would fight the user's own edits the instant they
  // made one before the walk settled.
  const seedAppliedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!walkSeed || walkSeed.nodeId !== nodeId || walkStatus !== 'done') return
    if (seedAppliedRef.current === nodeId) return
    seedAppliedRef.current = nodeId
    // T26 R1 — routed through `viewStateForTransition`, the single owner
    // of what SURVIVES from a seed vs RESETS (`walkedThrough`/`drawnRank`
    // re-derive from the replayed model; `viewRadius` defaults to the
    // restored walk's own fetched depth — see that function's own
    // per-field disposition for the full reasoning, previously inline
    // here). No `prev` to offer — this is a one-time restore, not an
    // edit of whatever view state preceded it.
    setViewState({
      nodeId,
      view: viewStateForTransition('share-restore', null, { sg, seed: walkSeed }),
    })
    setDirectionState({ nodeId, dir: walkSeed.direction })
  }, [walkSeed, nodeId, walkStatus, sg])
  // T26 — a walkSeed restore PENDING for this exact focal (named by the
  // seed, not yet reflected in `viewState`) makes the walkedThrough/
  // drawnRank feedback effects below UNSAFE for one render: `layout`
  // there is built from `freshView` (the state the seed's own effect
  // above is about to replace wholesale, in the SAME commit) — React
  // applies queued updates in effect-DECLARATION order, so a feedback
  // effect declared after this one would receive the seed's own
  // freshly-restored view as `prev` and overwrite its `walkedThrough`
  // with a value computed BEFORE the seed ever ran, silently
  // re-collapsing containment levels the seed explicitly asked to keep
  // expanded. Found via the journey suite's own seam step — a restored
  // share link deep-nesting the reveal state is not reachable through
  // any ordinary follow control, so no existing pin exercised this
  // exact interleaving. A plain render-time value (props + state, never
  // `seedAppliedRef` — reading a ref during render is banned by this
  // codebase's own lint rule, and would race against the SAME effect
  // ordering this guard exists to avoid).
  const seedPendingForFocal = !!walkSeed && walkSeed.nodeId === nodeId && walkStatus === 'done' && viewState?.nodeId !== nodeId

  // T28 R3 — THE PIPELINE'S ORDERED SPINE. Three stages, always in this
  // order: buildFocusLayout → applyCondensation → enforceLensInvariants
  // (invariants.ts, always LAST). The window stage (`applyHopWindow`)
  // that used to sit between condensation and the invariant stage is
  // gone — the user's own ruling was "focus mode should walk the tree
  // to eternity," so the board just grows; nothing removes a band
  // anymore. Condensation is licensed to remove exactly one thing
  // (pass-through interiors) — the invariant stage is the global
  // enforcement that it didn't remove more than that, checked once,
  // after everything, rather than trusted per-pass.
  // EVERYTHING FETCHED IS DRAWN (user ruling, 2026-08-21). The layout's
  // reveal budget used to admit twelve root-most groups per direction and
  // hold the rest behind a "+N" pill — even though the walk had already
  // brought them back — which read as "One hop doesn't show my immediate
  // lineage". Now every walked node is admitted through a derived pinned
  // set in BOTH modes; the reveal budget only ever governs what is NOT in
  // hand, which after the hands-free hop-1 is nothing. Derived, never
  // written back into the view state: the share link and the user's own
  // placements stay theirs.
  const layoutView = useMemo(() => {
    if (!model || model.nodes.length === 0) return view
    const pinned = new Set(view.pinned)
    for (const n of model.nodes) pinned.add(n.urn)
    return { ...view, pinned }
  }, [model, view])

  const layout = useMemo(() => buildFocusLayout({
    sg,
    view: layoutView,
    query,
    hiddenTypes,
    extendStatus: walk?.extendStatus ?? EMPTY_EXTEND_STATUS,
    childrenAll,
    childrenAllStatus,
    walkStatus,
    directionFilter,
    density,
    wires,
  }), [sg, layoutView, query, hiddenTypes, walk?.extendStatus, childrenAll, childrenAllStatus, walkStatus, directionFilter, density, wires])

  // T23 R2 — pass-through condensation, a pure re-projection over the
  // built layout (never touches population/grain/rank). OFF unless the
  // reader asks for it (the "Steps" control in the header): the default
  // is the full end-to-end flow, every hop its own card, per the user's
  // own ruling. Skipping the stage entirely rather than passing an
  // all-open set keeps the un-condensed board byte-identical to the
  // layout — no connector edges, no re-condense controls, nothing for a
  // chip to be drawn over.
  const condensed = useMemo(
    () => (condenseSteps ? applyCondensation(layout, view.condensedOpen) : layout),
    [condenseSteps, layout, view.condensedOpen],
  )
  // T26 R2 — the invariant stage: the focal card is drawn (a), the board
  // is never empty while `layout` still has the focus (b — T17-A's
  // guarantee, T25-C2's own inline fallback, both relocated here so no
  // later pass can silently undermine them), every edge endpoint
  // resolves to a drawn card (c), and no card claims an undrawn frame
  // (d). `layout` (pre-condensation) is the one fallback stage left now
  // the window is gone — condensation is licensed to remove interiors,
  // never the focal, so this is the same "stage immediately before it"
  // relationship the window used to have with `condensed`. See
  // invariants.ts's own doc comment for the full contract and the
  // degradation each violation takes.
  const boardGraph = useMemo(
    () => enforceLensInvariants(condensed, layout).graph,
    [condensed, layout],
  )
  // One control, two meanings depending on which side is currently
  // showing: a condensed run's own connector chip ADDS itself here
  // (unfolds), and its unfolded boundary's re-condense control REMOVES
  // itself (folds back) — each control only ever renders in the state
  // where its own click is the toggle's only possible direction.
  const toggleCondense = useCallback((connectorId: string) => {
    editView(base => {
      const next = new Set(base.condensedOpen)
      if (next.has(connectorId)) next.delete(connectorId)
      else next.add(connectorId)
      return { ...base, condensedOpen: next }
    })
  }, [editView])

  // The grain is STICKY: a level once drawn through stays drawn through
  // while this walk grows, or a second child arriving would turn a level
  // the picture saw past into a card and swallow what is already on the
  // board. The layout reports what it walked through; this folds it back
  // in, grow-only, so it converges in one pass and re-centering (a new
  // view state) starts clean.
  useEffect(() => {
    // See `seedPendingForFocal`'s own doc comment above.
    if (seedPendingForFocal) return
    const seen = view.walkedThrough
    if ([...layout.walkedThrough].every(u => seen.has(u))) return
    // RATIFIED PATTERN, not an oversight: the layout is a pure function
    // of the view state, and the two facts below are things it can only
    // know once it has BUILT — which level it saw through, and which slot
    // each card took. Feeding them back is the sanctioned way that
    // converges (grow-only, one extra pass, then a no-op), and it is the
    // mechanism the free-flow work was signed off on. Restructuring it is
    // a behavioural change; silencing it here is what keeps this file
    // GREEN under lint, so the next rules-of-hooks error is visible —
    // which is the whole lesson of the crash that shipped from here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    editView(base => ({ ...base, walkedThrough: new Set(layout.walkedThrough) }))
  }, [layout.walkedThrough, view.walkedThrough, editView, seedPendingForFocal])

  // And so is the ORDER. A card's rank comes from its weight, and weight
  // grows as the walk does — so a merge re-ordered cards already on the
  // board, under the pointer of the user whose click caused the merge.
  // The layout reports the slot each drawn entity holds; this folds it
  // back, grow-only, so arrivals append instead of shuffling.
  useEffect(() => {
    // See `seedPendingForFocal`'s own doc comment above.
    if (seedPendingForFocal) return
    if (layout.drawnRank.size === view.drawnRank.size) return
    // Same ratified layout→view feedback as `walkedThrough` above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    editView(base => ({ ...base, drawnRank: new Map(layout.drawnRank) }))
  }, [layout.drawnRank, view.drawnRank, editView, seedPendingForFocal])

  const neighbors = useMemo(() => walkNeighborRecords(sg), [sg])
  const inConnections = neighbors.incoming.reduce((n, r) => n + r.weight, 0)
  const outConnections = neighbors.outgoing.reduce((n, r) => n + r.weight, 0)


  /** T23 R3 — a triage-list PLACEMENT: admit one or more specific urns
   *  regardless of rank or reveal budget (`LensViewState.pinned`,
   *  `buildFocusLayout`'s own admission for it). Grow-only, like every
   *  other view-state edit here. */
  const pinEntities = useCallback((urns: readonly string[]) => {
    editView(base => {
      const next = new Set(base.pinned)
      for (const urn of urns) next.add(urn)
      return { ...base, pinned: next }
    })
  }, [editView])


  // ── Growing the walk ───────────────────────────────────────────────

  /** Instant: a page of neighbours already in the model. No fetch. */
  const revealMore = useCallback((key: string) => {
    editView(base => {
      const revealed = new Map(base.revealed)
      revealed.set(key, (revealed.get(key) ?? 0) + 1)
      return { ...base, revealed }
    })
  }, [editView])

  /**
   * ONE CLICK, ONE VISIBLE DELIVERY.
   *
   * A fetch alone does not put anything on the board. The layout admits a
   * card's neighbours only where the view state has opened a REVEAL PAGE on
   * that card, and an extend/page click used to open none — so the response
   * merged into the model, the card's ×N and the focal's reach both grew,
   * and the picture did not change. The pill then re-read the model, found
   * the arrivals sitting there unadmitted, and offered them as a REVEAL: the
   * reported "+246, click, nothing, +1, click again".
   *
   * So the page is opened HERE, at click time, and it is what makes the
   * fetched cohort render the moment the merge lands.
   *
   * THE INVARIANT THAT MAKES THAT SAFE, stated exactly: `pillFor` offers a
   * fetch only once NOTHING reachable from this card's subtree is still
   * unadmitted, and the page this opens admits from that same subtree —
   * one `rankedGroups` call, shared. So at the moment of an extend or page
   * click the budget has no competitor, and the arrivals are the only
   * thing it can spend itself on. (It did NOT hold while the pill asked
   * from what a card visually stands for: an open frame's rows own
   * themselves, so a frame could offer a fetch with a dozen unrevealed
   * row-neighbours still queued, and they would take the page instead.)
   *
   * A cohort larger than one page still leaves an honest remainder behind;
   * what it can never do again is deliver nothing.
   */
  /**
   * THE TRAIL's other half. `entries` (focus history) is the walked
   * PATH; a card the reader grew the board FROM without re-anchoring on
   * it — an extend or page click — is just as deliberately "walked
   * through" but never becomes a focal, so it would otherwise leave no
   * mark. Grown, never reset for the lens's whole open session (like
   * `entries` itself) — a mark is a record of what happened, not of
   * what the current focal is.
   */
  const [extendAnchors, setExtendAnchors] = useState<ReadonlySet<string>>(new Set())
  const markAnchor = useCallback((urn: string) => {
    setExtendAnchors(prev => (prev.has(urn) ? prev : new Set(prev).add(urn)))
  }, [])

  const extendWalk = useCallback((_key: string, urn: string, dir: 'in' | 'out') => {
    walkApi.extend(urn, toWalkDir(dir), seedLeavesFor(sg, urn, dir))
    markAnchor(urn)
    // Room for what is coming, claimed at CLICK time. This used to wait
    // for the fetch to land so it could decide between revealing the
    // page and opening the hub-triage list; the list is gone, so there
    // is nothing left to decide and nothing to wait for.
    revealMore(revealKey(dir, urn))
  }, [walkApi, sg, revealMore, markAnchor])

  // T24 F7 — a stable identity, same reason `extendWalk` needs one: an
  // inline arrow here would give `FocusGraphView`'s own `ctx` a new
  // reference every render, and its card memo comparators start with
  // `a.ctx === b.ctx` — every card would re-render on every tick.
  const seedCountForCtx = useCallback(
    (urn: string, dir: 'in' | 'out') => seedLeavesFor(sg, urn, dir).length,
    [sg],
  )

  /** The rest of THIS node's adjacency, with the server's own cursor —
   *  and, for the same reason as `extendWalk`, room to draw what arrives. */
  const pageWalk = useCallback((urn: string, dir: 'in' | 'out', cursor: string) => {
    walkApi.page(urn, toWalkDir(dir), cursor)
    markAnchor(urn)
    revealMore(revealKey(dir, urn))
  }, [walkApi, revealMore, markAnchor])

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
      // leaving the window parked where the matches may not reach.
      const offsets = new Map(base.frameOffsets)
      offsets.delete(urn)
      return { ...base, frameQueries: queries, frameOffsets: offsets }
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
   * reaches a column on page 7 of a wide table without paging to it —
   * an entity the walk never carried at all, not only one paged past.
   * Connected mode's OWN set is the model already in hand, and the
   * layout filters it locally for free; but what the walk has NOT
   * reached is exactly what a Connected-mode Find used to go silent
   * on (T24 F2), so this reaches the server in BOTH modes once there
   * is something to ask it.
   */
  const frameQueriesNow = view.frameQueries
  const frameShowAllNow = view.frameShowAll
  useEffect(() => {
    if (!onLoadAllChildren) return
    const urns = new Set([...frameShowAllNow, ...frameQueriesNow.keys()])
    if (urns.size === 0) return
    const t = setTimeout(() => {
      for (const urn of urns) {
        const showingAll = frameShowAllNow.has(urn)
        const want = (frameQueriesNow.get(urn) ?? '').trim()
        // Connected mode has nothing to search until there IS a query —
        // otherwise its set is the model already in hand, filtered
        // locally, and asking the server for an unfiltered roster it
        // will never show is a fetch that answers nothing.
        if (!showingAll && want === '') continue
        const have = childrenAll.get(urn)
        // A missing FIRST page is fetched here only when it was NEVER
        // ASKED FOR (no status at all). This used to skip ANY missing
        // first page, assuming a click always preceded showAll — but the
        // Contents=All FOCAL seed and a share link's restored frameAll
        // arrive with no click, so their rosters were never fetched and
        // a focused container drew only its flow rows ("only the 1st of
        // my 10 children shows", 2026-08-19). The guard is the STATUS,
        // not the missing page: 'loading' is the toggle handler's own
        // in-flight fetch, and 'error'/'unsupported' are ANSWERS —
        // refiring on "still missing" turned one backend failure into a
        // 673-request children-with-edges storm (the poll-chain-leak
        // class; never auto-retry).
        if (showingAll && !have) {
          if (childrenAllStatus.get(urn) === undefined) onLoadAllChildren(urn)
          continue
        }
        if (have && (have.query ?? '') === want) continue
        onLoadAllChildren(urn, want)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [frameQueriesNow, frameShowAllNow, childrenAll, childrenAllStatus, onLoadAllChildren])

  /**
   * Rest a frame's scroll window on an absolute row. Fetching is
   * decoupled from scrolling: one server page backs many rows of travel,
   * so we only ask when the window nears the end of what is loaded.
   *
   * `offset` arrives already clamped by the view (which is the side that
   * knows how many rows there are), so this only ever records it.
   */
  const setFrameOffset = useCallback((urn: string, offset: number) => {
    let showingAll = false
    let q = ''
    editView(base => {
      showingAll = base.frameShowAll.has(urn)
      // The rows we scroll into belong to whatever list is on screen.
      // Asking without the query made the hook see a DIFFERENT question
      // and refetch the first page unfiltered.
      q = base.frameQueries.get(urn) ?? ''
      const offsets = new Map(base.frameOffsets)
      offsets.set(urn, Math.max(0, offset))
      return { ...base, frameOffsets: offsets }
    })
    if (!showingAll) return
    // One page is one ask. A scroll crosses the "nearly there" line on
    // several consecutive steps, and each of them would otherwise fire
    // its own fetch for the page already on its way.
    if (childrenAllStatus.get(urn) === 'loading') return
    const loaded = childrenAll.get(urn)
    // One SERVER page backs many rows of scrolling, so travelling inside
    // what is already loaded must not ask for anything. The page is
    // fetched a windowful BEFORE the reader reaches the end, so the list
    // keeps moving instead of stopping dead at the last loaded row.
    const wanted = Math.max(0, offset) + FRAME_WINDOW_ALL * 2
    if (!loaded || (loaded.hasMore && loaded.children.length < wanted)) onLoadAllChildren?.(urn, q)
  }, [editView, childrenAll, childrenAllStatus, onLoadAllChildren])

  const retryFrameAll = useCallback(
    (urn: string) => onLoadAllChildren?.(urn, view.frameQueries.get(urn) ?? ''),
    [onLoadAllChildren, view.frameQueries],
  )

  const retryWalk = useCallback(() => { if (nodeId) walkApi.retry(nodeId) }, [nodeId, walkApi])

  const setSelection = useCallback((selection: string | null) => {
    editView(base => ({ ...base, selection }))
  }, [editView])

  /**
   * The card whose lineage cone a CLICK stuck on. Lens-local and keyed to
   * the focal, like the filter and the chips: a new focal is a new
   * question, and an isolation on a card that is no longer drawn would be
   * a dimmed board with nothing lit.
   *
   * Held here rather than inside the board because Escape is the LENS's
   * key, in one place, and it has to be able to clear this in order.
   */
  /**
   * THE TRAIL — cards the reader explicitly walked through: every focal
   * this session has visited (`entries`) plus every card an extend/page
   * click grew the board from (`extendAnchors`). Minimal treatment (a
   * marker + firmer wire), so it costs one Set union and one pass over
   * consecutive history pairs — no new tracking beyond the history this
   * lens already keeps and the anchors just above.
   */
  const trailUrns = useMemo(
    () => new Set([...entries, ...extendAnchors]),
    [entries, extendAnchors],
  )
  /** Wires ON the trail: between two CONSECUTIVE focal history entries —
   *  the hop actually walked, not merely two cards that both happen to
   *  carry a mark. Keyed unordered (a bundle's drawn direction need not
   *  match the walk's). */
  const trailAdjacent = useMemo(() => {
    const pairs = new Set<string>()
    for (let i = 1; i < entries.length; i++) {
      const [a, b] = [entries[i - 1], entries[i]].sort()
      pairs.add(`${a}|${b}`)
    }
    return pairs
  }, [entries])

  const [isolationState, setIsolationState] = useState<{ nodeId: string | null; cardId: string | null }>({ nodeId: null, cardId: null })
  const isolatedId = isolationState.nodeId === nodeId ? isolationState.cardId : null
  const setIsolated = useCallback(
    (cardId: string | null) => setIsolationState({ nodeId, cardId }),
    [nodeId],
  )

  /**
   * THE DISMISS LADDER — one owner for Escape, and for a click on the
   * board's own background.
   *
   * It dismisses innermost-first: a row's preview is a panel inside the
   * lens, and closing the whole room out from under what you just opened
   * is the one behaviour nobody expects. A second capture handler
   * further in could not do this — mount order decides which of two
   * runs, and the outer one always wins — so the sequence lives here
   * rather than being split.
   */
  const selection = view.selection
  /**
   * ONE layer at a time, innermost first: the preview beside a row, then
   * the isolated lineage, then the selection, then the room itself.
   *
   * Each press (and each click on the board behind everything) undoes
   * exactly the last thing that was opened — closing the whole room out
   * from under what you just opened is the one behaviour nobody expects,
   * and it is just as wrong for a click as it is for a key.
   *
   * The PEEK is the selection when the selected card is a ROW; a
   * selection that is not a row has no panel, so it is a layer further
   * out. That is the only reason these two share a piece of state.
   */
  const peekOpen = selection !== null
    && layout.cards.some(c => c.nodeId === selection && c.frameId !== null)

  /**
   * A CLICK ON THE BOARD'S BACKGROUND NEVER CLOSES THE ROOM.
   *
   * It peels one layer and stops. This used to fall through to
   * `onClose()` when nothing was open, which meant that clicking any
   * empty part of the lens — the board around the cards, the space
   * inside a frame — threw the whole walk away. Reported live as "if I
   * click anywhere within a window of Focus Lens it has a tendency to
   * close randomly"; the empty board is the largest target in the room,
   * so it was not random at all.
   *
   * Returns whether it actually peeled something, so the ONE caller that
   * may go further (Escape) can tell "I closed a panel" from "there was
   * nothing left to close".
   */
  const dismissLayer = useCallback((): boolean => {
    if (peekOpen) { setSelection(null); return true }
    if (isolatedId !== null) { setIsolated(null); return true }
    if (selection !== null) { setSelection(null); return true }
    return false
  }, [peekOpen, isolatedId, selection, setIsolated, setSelection])

  /**
   * HAS THE READER BUILT ANYTHING WORTH LOSING? Compared against the
   * state this focal OPENED with (`viewStateForTransition`'s own fresh
   * value — one reveal each way, the focus's own ancestors expanded),
   * plus the history: a second entry means they re-anchored at least
   * once. Anything more than that is a walk somebody spent clicks on.
   */
  const openingView = useMemo(() => initialLensViewState(sg), [sg])
  const hasWalked = entries.length > 1
    || view.revealed.size > openingView.revealed.size
    || view.expandedContainment.size > openingView.expandedContainment.size
    || view.collapsedContainment.size > 0
    || view.frameShowAll.size > 0
    || view.condensedOpen.size > 0

  /** What the reader would be throwing away, in their own terms — a
   *  count of cards is the honest measure of "how far did I get". */
  const walkSummary = entries.length > 1
    ? `You have walked ${entries.length} entities and drawn ${layout.cards.length.toLocaleString()} cards.`
    : `You have drawn ${layout.cards.length.toLocaleString()} cards on this board.`

  /** Leaving the room — from the backdrop, the × or the last Escape.
   *  Asks first once there is a walk to lose (user, 2026-08-17). */
  const [confirmClose, setConfirmClose] = useState(false)
  const requestClose = useCallback(() => {
    if (hasWalked) { setConfirmClose(true); return }
    onClose()
  }, [hasWalked, onClose])

  useEffect(() => {
    if (!nodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // The confirmation is itself the innermost layer while it is up:
        // Escape backs out of the QUESTION, never answers it.
        if (confirmClose) { setConfirmClose(false); return }
        if (dismissLayer()) return
        requestClose()
        return
      }
      // Keyboard walking: ← back one hop, → forward one hop — browser
      // history semantics. Never while typing in a filter box, and never
      // while browsing a frame's rows: inside a row list the arrows walk
      // the list, and a lens that stepped a hop back instead would take
      // the list away mid-read.
      if ((e.key === 'ArrowLeft' && canBack) || (e.key === 'ArrowRight' && canForward)) {
        // `closest` only exists on Elements — a key dispatched straight
        // at the window has no element to ask.
        const t = e.target as HTMLElement | null
        // AN OPTION AS WELL AS ITS LISTBOX, and that is the whole of the
        // reported unreliability: a frame's rows are not DOM DESCENDANTS
        // of the list that owns them. React Flow draws every row as the
        // frame's SIBLING (which is what lets a wire land on one row of a
        // 400-column table), so the list owns them by id — `aria-owns`
        // and `aria-activedescendant` — and `closest('[role=listbox]')`
        // from a row finds nothing at all.
        //
        // Rows carry `tabIndex={-1}` and a click focuses one, so the
        // shape is ordinary: click a row to preview it, press ← expecting
        // T16's "step back out of the rows", and the LENS stepped a HOP
        // back instead — the board replaced under a reader who was
        // browsing a table. (The row's own handler could not have saved
        // it either: this listener is in the CAPTURE phase, and nothing
        // dispatched at a sibling ever reaches the list's `onKeyDown`.)
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
          || (typeof t.closest === 'function' && t.closest('[role="listbox"],[role="option"]')))) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowLeft') onBack()
        else onForward()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, canBack, canForward, onBack, onForward, dismissLayer, requestClose, confirmClose])

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

  // EVERY NAME THE LENS HAS SHOWN (2026-08-22). The Path trail read each
  // chip off the CURRENT model, so a focus you had left — whose node the
  // new model does not carry — fell back to its URN fragment
  // ("gold_af963e43 › Snowflake › …"). Names seen in any model this
  // session are remembered; a stop never drawn here (a restored link) is
  // asked of the canvas. Folded on the model change itself (the
  // previous-render pattern), never in an effect.
  const [labelMemory, setLabelMemory] = useState<{ sg: typeof sg; names: ReadonlyMap<string, string> }>(
    () => ({ sg, names: rememberNames(sg, new Map()) }),
  )
  if (labelMemory.sg !== sg) setLabelMemory({ sg, names: rememberNames(sg, labelMemory.names) })
  const labelFor = useCallback(
    (urn: string) => {
      const node = sg.nodes.get(urn)?.node
      if (node) return labelOf(urn, node)
      return labelMemory.names.get(urn) ?? labelHintFor?.(urn) ?? labelOf(urn, undefined)
    },
    [sg, labelMemory.names, labelHintFor],
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
  //
  // Never for a ROW: a row's click opens the PEEK, anchored beside it,
  // which says the same things and offers the moves that make sense from
  // there. Two panels describing one click is one panel too many.
  const selectedInfo = useMemo(() => {
    const sel = view.selection
    const node = sel ? sg.nodes.get(sel) : undefined
    if (!sel || !node) return null
    if (layout.cards.some(c => c.nodeId === sel && c.frameId !== null)) return null
    return {
      id: sel,
      label: labelOf(sel, node.node),
      type: (node.node?.data?.type as string) ?? node.node?.entityType ?? 'not loaded',
      description: (node.node?.data?.description as string | undefined) ?? null,
      parentLabel: node.parent ? labelOf(node.parent, sg.nodes.get(node.parent)?.node) : null,
      inCount: node.degreeUp,
      outCount: node.degreeDown,
    }
  }, [view.selection, sg, layout.cards])

  // ── Share this exploration — the walked path AND the current focal's
  // exploration (revealed/opened/searched, the direction preset, the
  // depth control) as a link a colleague can open exactly where you left
  // it. Encoded on demand, from whatever is on screen right now.
  const [shareCopied, setShareCopied] = useState(false)
  // T24 F3 — the PATH bar's own "Copy path" (text) gets the same
  // copied-state feedback the header's link button already had, so
  // BOTH of the bar's actions confirm the click rather than one of them
  // doing so silently.
  const [pathCopied, setPathCopied] = useState(false)
  const copyShareLink = () => {
    const token = encodeLensShare({
      entries,
      cursor,
      mode: lensViewMode,
      direction: directionFilter,
      depth: lensInitialDepth,
      revealed: [...view.revealed],
      opened: [...view.expandedContainment],
      collapsed: [...view.collapsedContainment],
      frameAll: [...view.frameShowAll],
      framePages: [...view.frameOffsets],
      frameQueries: [...view.frameQueries],
      pinned: [...view.pinned],
      condensedOpen: [...view.condensedOpen],
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

  // The focal's own roster, asked for once — the membership half, which
  // lineage structurally cannot answer.
  //
  // Only when the focal could plausibly hold something: the walk found
  // children inside it, or it declared a childCount. A column focal —
  // the commonest thing this lens is opened on — holds nothing, and
  // asking anyway spent a round trip on every hop of every walk. The
  // gate never costs honesty: with no roster the focal simply does not
  // claim a total it was never told.
  const focalHolds = (sg.nodes.get(nodeId ?? '')?.children.length ?? 0) > 0
    || ((sg.nodes.get(nodeId ?? '')?.node?.data?.childCount as number | undefined) ?? 0) > 0
  const focalKidsAskedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!nodeId || !onLoadChildrenOf) return
    if (focalKidsAskedRef.current === nodeId) return
    if (walkStatus !== 'done' || !focalHolds) return
    focalKidsAskedRef.current = nodeId
    onLoadChildrenOf(nodeId)
  }, [nodeId, onLoadChildrenOf, walkStatus, focalHolds])

  /**
   * How far the walk has actually reached, and whether that is the
   * whole story. Not a measurement of its own: these are the entities
   * the server has NAMED as upstream / downstream of the focus, which
   * is the number every other surface here is derived from.
   *
   * A "+" says the data source has MORE OF THIS SIDE. A frontier entry
   * on a node inside the focus whose lineage never leaves it says no
   * such thing — it is the inside having more inside — so the floor is
   * read through the same boundary rule the ⊕ and its seeds use.
   * Reported live: the platform Snowflake, whose 51 interior frontier
   * entries put a "+" on a side its own closure reports as empty.
   *
   * Memoized because reading it walks the model twice, and this sits in
   * a component that re-renders on every keystroke in the filter box.
   *
   * ABOVE the `!nodeId` return, with every other hook, and it has to be:
   * memoizing it BELOW made the hook count depend on whether the lens had
   * a focal, and React threw "Rendered more hooks than during the
   * previous render" the moment one arrived. A cap applies to the whole
   * fetch, so it makes BOTH sides floors; a frontier only makes its own.
   */
  const capped = (model?.truncated ?? false) || (model?.seedTruncated ?? false)
  const reach: LensReach | null = useMemo(() => {
    if (!model || !nodeId || walkStatus !== 'done') return null
    const more = (dir: 'in' | 'out'): boolean => {
      const offers = boundaryFrontierFilter(sg, nodeId, dir)
      return (dir === 'in' ? model.frontierUp : model.frontierDown).some(f => offers(f.urn))
    }
    // The coarse page's partners, counted at CARD grain: the endpoints the
    // inner-first accounting left standing (a database whose cells are
    // fully stated by its tables is not a partner beside them).
    const residuals = (model.coarseUpstreamUrns?.size || model.coarseDownstreamUrns?.size) ? rollupResiduals(model) : null
    const approxOn = (side: ReadonlySet<string> | undefined) =>
      residuals ? [...(side ?? [])].filter(u => (residuals.get(u) ?? 0) > 0).length : 0
    // PARTNERS, not participants: a container focus whose contents feed
    // each other carries those contents on its direction sets (the server
    // walks from its columns), and they are internal flows — in the gutter,
    // counted on the focus — never "sources". Reported: "Fed by 11 sources"
    // over an empty upstream band on a platform focus (2026-08-22).
    const inside = new Set(focusSideOf(sg))
    const outside = (side: ReadonlySet<string>) => new Set([...side].filter(u => !inside.has(u)))
    const upstream = outside(model.upstreamUrns)
    const downstream = outside(model.downstreamUrns)
    return {
      up: upstream.size,
      down: downstream.size,
      moreUp: capped || more('in'),
      moreDown: capped || more('out'),
      upSystems: distinctSystemCount(sg, upstream.size > 0 ? upstream : (model.coarseUpstreamUrns ?? upstream)),
      downSystems: distinctSystemCount(sg, downstream.size > 0 ? downstream : (model.coarseDownstreamUrns ?? downstream)),
      approxUp: approxOn(model.coarseUpstreamUrns),
      approxDown: approxOn(model.coarseDownstreamUrns),
    }
  }, [model, nodeId, sg, walkStatus, capped])

  if (!nodeId) return null

  const focalNode = sg.nodes.get(nodeId)?.node
  const focalLabel = labelFor(nodeId)
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

  // The header counts what the header's own preset is showing. Under
  // "Root cause" the board draws no consumers, no downstream pill and no
  // downstream band — a count line still totalling them is the one number
  // on screen that describes a different picture.
  const headerConnections = (directionFilter === 'out' ? 0 : inConnections)
    + (directionFilter === 'in' ? 0 : outConnections)
  const q = query.trim().toLowerCase()
  const filterFn = (r: WalkNeighbor) => q === '' || r.label.toLowerCase().includes(q)

  // THE VIEW CONTROLS (2026-08-22): one chip per category, each opening a
  // menu of its options with their meanings. Six captioned segmented
  // groups in a row crowded the search box off the header; six chips
  // showing their current value fit beside each other with room to spare.
  const viewControls: Partial<Record<ToolbarGroupId, ReactNode>> = lensViewMode !== 'graph' ? {} : {
    // DIRECTION IS FIRST CLASS (2026-08-22): the question itself — upstream,
    // downstream, or the whole story — is never behind a click. An
    // always-expanded segmented control heads the row; the chips follow.
    direction: (
      <div
        data-tour="lens-direction"
        role="group"
        aria-label="Which side of the story to show"
        className="flex items-center h-7 p-0.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04]"
      >
        {([
          { dir: 'both', Icon: LucideIcons.ArrowLeftRight, label: 'Both', meaning: 'Upstream and downstream — the whole story' },
          { dir: 'in', Icon: LucideIcons.ArrowDownLeft, label: 'Root cause', meaning: 'Only what feeds this entity — upstream' },
          { dir: 'out', Icon: LucideIcons.ArrowUpRight, label: 'Impact', meaning: 'Only what this entity feeds — downstream' },
        ] as const).map(({ dir, Icon, label, meaning }) => (
          <ControlTip key={dir} name={label} meaning={meaning}>
            {(tip) => (
              <button
                type="button"
                onClick={() => setDirectionFilter(dir)}
                aria-describedby={tip['aria-describedby']}
                aria-pressed={directionFilter === dir}
                className={cn(
                  tip.peer,
                  'flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                  directionFilter === dir
                    ? 'bg-canvas-elevated text-accent-lineage shadow-sm border border-black/[0.06] dark:border-white/[0.08]'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="w-3 h-3" />
                {label}
              </button>
            )}
          </ControlTip>
        ))}
      </div>
    ),
    density: (
      <ViewControl
        data-tour="lens-density"
        caption="Density"
        meaning="How much of the picture is folded — the numbers are the same at every rung"
        value={density}
        onChange={setDensity}
        options={[
          { value: 'overview', label: 'Overview', Icon: LucideIcons.Layers, meaning: 'Start at the high level — partners that share a container land as that container, closed, with counts; each click opens one level' },
          { value: 'grouped', label: 'Grouped', Icon: LucideIcons.Group, meaning: 'Partners that share a container fold into it, its strongest rows first; the rest is one click away' },
          { value: 'all', label: 'Every card', Icon: LucideIcons.LayoutGrid, meaning: 'Draw every card on its own, however many there are' },
        ]}
      />
    ),
    wires: (
      <ViewControl
        caption="Wires"
        meaning="How the wires between two containers draw"
        value={wires}
        onChange={setWires}
        options={[
          { value: 'auto', label: 'Auto', Icon: LucideIcons.Spline, meaning: 'Two containers with more than 12 wires between them draw one bundle with the count; hover or select a card to see its own wires' },
          { value: 'bundled', label: 'Bundled', Icon: LucideIcons.GitMerge, meaning: 'One wire per pair of containers, with the count; hover or select a card to see its own wires' },
          { value: 'all', label: 'Every wire', Icon: LucideIcons.Waypoints, meaning: 'Draw every wire, however many there are' },
        ]}
      />
    ),
    walk: onFullWalkToggle ? (
      <ViewControl
        caption="Walk"
        meaning="How far the lens walks on its own"
        value={fullWalkEnabled ? 'full' : 'one'}
        onChange={(v) => onFullWalkToggle(v === 'full')}
        options={[
          { value: 'one', label: 'One hop', Icon: LucideIcons.Footprints, meaning: 'Walk the flow yourself — ⊕ on a card fetches its next hop' },
          { value: 'full', label: 'Full flow', Icon: LucideIcons.Route, meaning: 'Trace mode: keep walking automatically until the whole end-to-end flow is drawn' },
        ]}
      />
    ) : null,
    steps: (
      <ViewControl
        caption="Steps"
        meaning="How a long pass-through path is drawn"
        value={condenseSteps ? 'condensed' : 'every'}
        onChange={(v) => setCondenseSteps(v === 'condensed')}
        options={[
          { value: 'every', label: 'Every step', Icon: LucideIcons.UnfoldHorizontal, meaning: 'Show the full end-to-end flow — every hop on the path is its own card' },
          { value: 'condensed', label: 'Condensed', Icon: LucideIcons.FoldHorizontal, meaning: 'Fold long runs of single pass-through steps into one "via N steps" connector — click a connector to open that run' },
        ]}
      />
    ),
    next: (
      <ViewControl
        data-tour="lens-children-mode"
        caption="Next"
        meaning="What the next container you open will show — one already open keeps its own setting"
        value={lensFrameChildren}
        onChange={setLensFrameChildren}
        options={[
          { value: 'connected', label: 'Connected', Icon: LucideIcons.Link2, meaning: 'Containers you open next show only what is on this lineage — this does not change one already open' },
          { value: 'all', label: 'All', Icon: LucideIcons.Rows3, meaning: 'Containers you open next show everything inside, with lineage marked where it exists — this does not change one already open' },
        ]}
      />
    ),
  }
  const toolbarInline = TOOLBAR_ORDER.filter(id => viewControls[id] && !collapsedGroups.has(id))
  const toolbarInMenu = TOOLBAR_ORDER.filter(id => viewControls[id] && collapsedGroups.has(id))

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
        {/* Backdrop — the ONE click outside the room, and the one that
            asks before throwing a walk away. */}
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={requestClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="relative flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-2xl shadow-black/40 overflow-hidden transition-[width,height,max-height] duration-300"
          style={
            // Graph exploration is a "focus room" — as much of the
            // window as it can take while still reading as a room over
            // the page, with a RESOLVED height (React Flow needs one).
            // The pixel caps this used to carry (1800×1100) were what
            // made it look small on a large display: the board is where
            // a big graph goes, so it gets the screen. The list keeps
            // its adaptive height so small neighborhoods don't get a
            // cavernous empty grid.
            lensViewMode === 'graph'
              ? { width: '96vw', height: '94vh' }
              : { width: 'min(1000px, 92vw)', maxHeight: 'min(72vh, 780px)', minHeight: 380 }
          }
          role="dialog"
          aria-label={`Connections of ${focalLabel}`}
        >
          {/* THE HEADER (2026-08-22): two rows. The first is identity and the
              actions that never move — name, counts, Center on focus,
              Back/Forward, SEARCH (always), help, share, close. The second
              is how the picture draws: one chip per category, each opening
              its options with their meanings, and a More menu only if a
              narrow window leaves no room (`useToolbarOverflow`). */}
          <div className="border-b border-black/[0.08] dark:border-white/[0.08]">
            <div className="relative flex items-center gap-2 pl-4 pr-12 pt-2.5 pb-2">
            <div
              className="w-7 h-7 flex-shrink-0 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${focalColor}1f` }}
            >
              <LucideIcons.Focus className="w-4 h-4" style={{ color: focalColor }} />
            </div>
            {/* The title never gives up its width to the controls — they fold
                instead (useToolbarOverflow measures this block as fixed). */}
            <div className="min-w-0 flex-shrink-0 max-w-[min(360px,28vw)]">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <h2 className="text-sm font-semibold text-ink leading-tight truncate">{focalLabel}</h2>
                {focalParentInHeader && (
                  <span className="flex-shrink-0 max-w-[160px] truncate text-[10px] text-ink-muted/70">
                    in {focalParentInHeader}
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1.5 text-[10.5px] text-ink-muted leading-tight whitespace-nowrap overflow-hidden">
                {/* Counted off the same model the board draws — there is
                    no second set of numbers to reconcile it against. */}
                <span>
                  {`${headerConnections} connection${headerConnections === 1 ? '' : 's'}${focalChildTotal > 0 ? ` · contains ${focalChildTotal}` : ''}`}
                </span>
                {walkStatus === 'loading' && (
                  <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
                )}
                {/* Where the walk stands, off the same model the board
                    draws. Counts tick — no percent, no total (the total is
                    unknowable, a percent would lie). The phases get their
                    own spinner because the initial fetch's one above stops
                    at 'done' while pages are still landing. */}
                {(walkProgress?.phase === 'seeding' || walkProgress?.phase === 'walking') && (
                  <span className="flex items-center gap-1 text-accent-lineage/90" data-testid="lens-walk-narration">
                    <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                    {walkProgress.phase === 'walking'
                      ? `walking the full flow · ${walkProgress.nodes.toLocaleString()} nodes · ${walkProgress.flows.toLocaleString()} flows · ${walkProgress.requests} requests`
                      : `loading the immediate lineage · ${walkProgress.nodes.toLocaleString()} nodes · ${walkProgress.flows.toLocaleString()} flows · ${walkProgress.requests} requests`}
                  </span>
                )}
                {walkProgress?.phase === 'done' && fullWalkEnabled && (
                  <span className="text-ink-muted/80">full flow drawn</span>
                )}
                {walkProgress?.phase === 'done' && !fullWalkEnabled && walkProgress.requests > 1 && (
                  <span className="text-ink-muted/80">immediate lineage complete</span>
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
                className="ml-2 flex-shrink-0 whitespace-nowrap flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
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
                  'flex-shrink-0 whitespace-nowrap flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                  canBack ? 'ml-1' : 'ml-2',
                )}
              >
                Forward
                <LucideIcons.ArrowRight className="w-3 h-3" />
              </button>
            )}
            {/* THE WAY BACK TO THE FOCUS, where the navigation lives. It was
                only an icon in the corner stack — "we should make it clearer
                for the user to find" (2026-08-22). A labelled button here,
                and the board offers the same thing by itself the moment
                the focus has left the screen. */}
            {lensViewMode === 'graph' && (
              <ControlTip name="Center on focus" meaning="Bring the focus back to the middle of the board at a readable size — after a zoom, a pan, or a layout switch">
                {(tip) => (
                  <button
                    type="button"
                    onClick={() => setRecenterSignal(n => n + 1)}
                    aria-describedby={tip['aria-describedby']}
                    className={cn(
                      tip.peer,
                      'flex-shrink-0 whitespace-nowrap flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-accent-lineage border border-accent-lineage/30 bg-accent-lineage/[0.06] hover:bg-accent-lineage/[0.12] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                      canBack || canForward ? 'ml-1' : 'ml-2',
                    )}
                  >
                    <LucideIcons.LocateFixed className="w-3 h-3" />
                    Center on focus
                  </button>
                )}
              </ControlTip>
            )}
              {/* THE PATH, in the row it belongs to — navigation. It takes
                  the room between the controls and the search, scrolling
                  sideways when a long walk needs more (2026-08-22: the
                  header's blank middle, put to use). */}
          {/* ── Path trail — the focus history as a visible, clickable
              path. Every visited hop is a chip; the cursor's chip is
              highlighted and hops AHEAD of the cursor stay visible
              (dimmed) — clicking any chip moves the cursor there
              without dropping the trail (browser history, not a
              destructive stack). ── */}
              {entries.length > 1 && onJumpTo ? (
            <nav aria-label="Path" className="flex-1 min-w-0 flex items-center gap-1 mx-2 px-2 py-1 rounded-lg bg-black/[0.025] dark:bg-white/[0.03] overflow-x-auto custom-scrollbar whitespace-nowrap">
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
                    setPathCopied(true)
                    window.setTimeout(() => setPathCopied(false), 1600)
                  }}
                  title="Copy this path as TEXT (fact_support.ticket_key → System A → …) — for a doc or a chat message, not a clickable link"
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors',
                    pathCopied
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
                  )}
                >
                  {pathCopied ? <LucideIcons.Check className="w-3 h-3" /> : <LucideIcons.Copy className="w-3 h-3" />}
                  {pathCopied ? 'Copied' : 'Copy path'}
                </button>
                {/* T24 F3 — the working share link (`copyShareLink`, same
                    codec as the header's Link2 button) lived ONLY in the
                    header, invisible from here — a reader scanning the
                    path for "how do I share this" found only the TEXT
                    action beside it. Same call, same URL; a distinct
                    label and icon keep text-vs-link from reading as one
                    offer twice. */}
                <button
                  type="button"
                  onClick={copyShareLink}
                  title="Copy a LINK to this view — opens exactly where you are now, for a colleague to click"
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors',
                    shareCopied
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
                  )}
                >
                  {shareCopied ? <LucideIcons.Check className="w-3 h-3" /> : <LucideIcons.Link2 className="w-3 h-3" />}
                  {shareCopied ? 'Copied' : 'Copy link to this view'}
                </button>
              </div>
            </nav>
              ) : <div className="flex-1" aria-hidden="true" />}
              <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
              <div className="relative flex-shrink-0">
                <LucideIcons.Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/70" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter connections…"
                  className="w-56 pl-6 pr-7 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.05] border border-black/10 dark:border-white/10 text-[11.5px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
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
                        <li><span className="font-medium text-ink">Click</span> a card — inspect it; a row shows a preview</li>
                        <li><span className="font-medium text-ink">Double-click</span> — focus there</li>
                        <li><span className="font-medium text-ink">⊕</span> on a card&apos;s outer edge — reveal or fetch its next hop</li>
                        <li><span className="font-medium text-ink">▸</span> beside a name — what is inside it</li>
                        <li><span className="font-medium text-ink">Scroll</span> inside an open container — browse its rows</li>
                        <li><span className="font-medium text-ink">Tab</span> into a container, then <span className="font-medium text-ink">↑ ↓</span> — walk its rows</li>
                        <li><span className="font-medium text-ink">Enter</span> — preview · <span className="font-medium text-ink">Shift+Enter</span> — focus there</li>
                        <li><span className="font-medium text-ink">→</span> open a row · <span className="font-medium text-ink">←</span> step back out · <span className="font-medium text-ink">type</span> to find</li>
                        <li><span className="font-medium text-ink">← / →</span> outside a container — step back / forward</li>
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
              </div>
            {/* The way out stays in the corner whether the controls wrapped
                or not — anchored to the dialog, not to the cluster. */}
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close"
              className="absolute top-3 right-4 w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <LucideIcons.X className="w-4 h-4" />
            </button>
            </div>
            {lensViewMode === 'graph' && (
              <div ref={toolbarRowRef} className="flex items-center gap-1.5 pl-4 pr-4 pb-2">
                {toolbarInline.map(id => (
                  <div key={id} data-toolbar-group={id} ref={registerGroup(id)} className="flex-shrink-0">
                    {viewControls[id]}
                  </div>
                ))}
                {toolbarInMenu.length > 0 && (
                  <div data-toolbar-menu className="flex-shrink-0">
                    <Popover.Root open={displayMenuOpen} onOpenChange={setDisplayMenuOpen}>
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          aria-label={`More view controls (${toolbarInMenu.length})`}
                          className={cn(
                            'flex items-center gap-1.5 h-7 px-2 rounded-lg border text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            displayMenuOpen
                              ? 'border-accent-lineage/40 bg-accent-lineage/[0.08] text-accent-lineage'
                              : 'border-black/10 dark:border-white/10 bg-canvas-elevated text-ink-muted hover:text-ink hover:border-black/20 dark:hover:border-white/20',
                          )}
                        >
                          <LucideIcons.SlidersHorizontal className="w-3.5 h-3.5" />
                          More
                          <span className="min-w-[1.1rem] px-1 rounded-full bg-accent-lineage/15 text-accent-lineage text-[9.5px] text-center tabular-nums">{toolbarInMenu.length}</span>
                          <LucideIcons.ChevronDown className="w-3 h-3 opacity-70" />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          align="start"
                          sideOffset={6}
                          className="z-[9999] rounded-xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-xl shadow-black/10 p-2 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-1"
                        >
                          <div className="flex flex-col items-start gap-1.5">
                            {toolbarInMenu.map(id => <div key={id}>{viewControls[id]}</div>)}
                          </div>
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  </div>
                )}
                {/* THE TYPE CHIPS share this row — a filter on the picture,
                    beside the controls that shape it — and never push a
                    control into More: the toolbar measures them as
                    flexible (data-toolbar-flex). */}
                {(typeChips.length > 1 || layout.hiddenByChips > 0) && (
                  <div data-toolbar-flex className="ml-auto min-w-0 flex items-center gap-x-2 overflow-x-auto custom-scrollbar whitespace-nowrap">
                    {typeChips.length > 1 && (
                      <TypeChips chips={typeChips} hiddenTypes={hiddenTypes} onToggle={toggleHiddenType} className="flex-nowrap" />
                    )}
                    {layout.hiddenByChips > 0 && (
                      <span className="flex-shrink-0 px-1.5 py-0.5 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[9.5px] text-ink-muted">
                        {layout.hiddenByChips} hidden by the type chips
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>


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
          {/* The walk's two valves. There is no budget strip any more: the
              immediate lineage and the full flow both complete by
              themselves (the header chip narrates, counts ticking). What
              can still stop a walk is the one-time MEMORY checkpoint —
              asked once, lifted for good — and a failed step, which is
              never retried silently. */}
          {walkProgress?.phase === 'checkpoint' && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
              <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
              <span>{`This flow is larger than ${walkProgress.nodes.toLocaleString()} nodes. Loading the rest may slow this browser — continue?`}</span>
              {onWalkContinue && (
                <button
                  type="button"
                  onClick={onWalkContinue}
                  className="ml-auto flex-shrink-0 font-semibold hover:underline"
                >
                  Continue
                </button>
              )}
            </div>
          )}
          {walkProgress?.phase === 'error' && walkStatus === 'done' && (
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
              <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
              <span>
                {`Part of the lineage could not be loaded — ${walkProgress.pending.toLocaleString()} step${walkProgress.pending === 1 ? '' : 's'} failed at the data source.`}
                {` ${model?.upstreamUrns.size ?? 0} upstream · ${model?.downstreamUrns.size ?? 0} downstream are on the board.`}
              </span>
              {onWalkRetry && (
                <button
                  type="button"
                  onClick={onWalkRetry}
                  className="ml-auto flex-shrink-0 font-semibold hover:underline"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {/* ── Body — the SAME layout at every depth: re-centering
              swaps the focal in place instead of flipping to a
              different presentation. Two bodies, one model: the
              interactive hop-band GRAPH — the Lens — and, DEPRECATED
              since 2026-08-22, the classic two-column LIST: no control
              offers it any more and a stored preference migrates to
              'graph'; the branch below stays one release for a safe
              rollback (`usePreferencesStore.setState({ lensViewMode:
              'list' })`) and then goes. ── */}
          {lensViewMode === 'graph' ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div data-tour="lens-graph" className="relative flex-1 min-h-0">
              <FocusGraphView
                graph={boardGraph}
                focalId={nodeId}
                // 'unsupported' deliberately passes NOTHING: the
                // empty-direction whispers are a claim about what the
                // data source SAID, and it was never asked.
                focalFetch={walkStatus === 'unsupported' ? undefined : walkStatus}
                focalReach={reach}
                exportName={focalLabel}
                directionFilter={directionFilter}
                selectedId={view.selection}
                isolatedId={isolatedId}
                trailUrns={trailUrns}
                trailAdjacent={trailAdjacent}
                reducedMotion={reducedMotion}
                // C4: while the hands-free walk lands cards the camera
                // holds its place and the board offers a fit instead.
                walking={walkProgress?.phase === 'loading' || walkProgress?.phase === 'seeding' || walkProgress?.phase === 'walking'}
                // A layout-mode switch is a new picture of the same focus:
                // the camera re-frames the focus rather than leaving the
                // reader wherever the previous layout had them (2026-08-22).
                recenterKey={`${density}|${condenseSteps ? 'condensed' : 'every'}|${directionFilter}`}
                recenterSignal={recenterSignal}
                edgeTypeInfo={edgeTypeInfo}
                onSelect={setSelection}
                onIsolate={setIsolated}
                onDismiss={dismissLayer}
                onFocus={onRecenter}
                onToggleFrame={toggleContents}
                onFrameScroll={setFrameOffset}
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
                // T24 F7 — the exact count a frame-level ⊕'s own click
                // would seed the walk from: the SAME call `extendWalk`
                // makes, so the hover text can never claim a number the
                // request itself would not back up.
                seedCountFor={walkStatus === 'done' ? seedCountForCtx : undefined}
                onCondenseRun={toggleCondense}
                onPin={pinEntities}
              />
              {/* THE CAPSULE — the board says it is calculating, from the
                  moment Focus opens (2026-08-22: the header's narration and
                  a toast at the foot of the board were missed — "the user
                  might confuse that for nothing happening"). The same
                  capsule the canvas trace uses: headline, ticking counts,
                  the sounding line; it leaves by itself a beat after the
                  walk completes. It shows the COMPUTING phases only — the
                  checkpoint and a failed step keep their strips below, so
                  nothing here decides anything. Before the driver has an
                  entry for this focus `walkProgress` is null and the
                  fetch status alone says loading. Keyed on the focus so a
                  re-anchor starts a fresh capsule. */}
              {/* THE PICTURE'S GHOST — sources → focus → consumers, drawn
                  as shimmering shapes until the first cards exist, so an
                  empty board never reads as nothing happening. */}
              {walkStatus === 'loading' && boardGraph.cards.length === 0 && <LensSkeleton />}
              {capsulePhase && (
                <TraceWalkIndicator
                  key={nodeId ?? ''}
                  phase={capsulePhase}
                  surface="lens"
                  subject={focalLabel}
                  nodes={walkProgress?.nodes ?? 0}
                  flows={walkProgress?.flows ?? 0}
                  requests={walkProgress?.requests ?? 0}
                  pending={walkProgress?.pending ?? 0}
                  error={null}
                  upCount={reach?.up ?? 0}
                  downCount={reach?.down ?? 0}
                  onContinue={onWalkContinue ?? noop}
                  onRetry={onWalkRetry ?? noop}
                />
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
                ? 'Click a card to inspect · ⊕ to walk a hop · ▸ to open what is inside · Scroll or ↑↓ inside it · Enter to preview, Shift+Enter to focus · Esc to close'
                : 'Click a connection to re-center · Esc to close'}
            </p>
            {/* The footer's two actions — "Reveal N on canvas" and "Trace
                from here" — are withdrawn for now (user, 2026-08-17).
                Both LEAVE the lens to do something to the canvas behind
                it, which is a different job from walking lineage, and
                both sat where a reader's eye lands after a long walk.
                The per-card "Show on the canvas behind" action still
                offers the first one for a single entity, which is the
                shape anyone actually asked for. `onLocateAll`/`onTrace`
                stay wired for their other callers (the peek, the
                coarser-grain rows) so bringing these back is a JSX
                change, not a re-plumb. */}
          </div>

          {/* LEAVING THE ROOM. A walk is work — hops fetched one click at
              a time, containers opened, a path followed — and it lives
              only while the lens is open. So the way OUT asks, once
              there is something to lose. (The board's own background
              never gets here at all: it peels a layer and stops.) */}
          {confirmClose && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
              <div
                role="alertdialog"
                aria-modal="true"
                aria-label="Leave this walk?"
                className="w-[380px] rounded-xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-2xl shadow-black/40 p-4"
              >
                <p className="text-[13px] font-semibold text-ink">Leave this walk?</p>
                <p className="mt-1 text-[11.5px] text-ink-muted leading-relaxed">
                  {walkSummary} Closing the lens starts over from {focalLabel}.
                </p>
                <div className="mt-3.5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    autoFocus
                    onClick={() => setConfirmClose(false)}
                    className="px-3 py-1.5 rounded-lg text-[11.5px] font-semibold text-ink bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.09] dark:hover:bg-white/[0.13] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                  >
                    Keep exploring
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmClose(false); onClose() }}
                    className="px-3 py-1.5 rounded-lg text-[11.5px] font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
                  >
                    Close the lens
                  </button>
                </div>
              </div>
            </div>
          )}
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
      className="flex items-center gap-1.5 mt-1.5 text-[10px] text-ink-muted"
      title={reach.moreUp || reach.moreDown
        ? 'What this walk has reached so far. A + marks a floor rather than a total — more exists that way. Use ⊕ on a card to walk further.'
        : 'Everything connected to this entity, upstream and downstream, as far as the data source goes.'}
    >
      <LucideIcons.Radar className="w-3 h-3 flex-shrink-0 text-accent-lineage/70" />
      {/* ONE span, ONE ellipsis — two independently-truncating spans cut
          mid-word on each half at once on a narrow card (see the graph
          body's own `orientationHalf` note for the reported shape). */}
      <span className="truncate min-w-0 tabular-nums">
        {orientationHalf('Fed by', 'source', 'upstream', reach.up, reach.moreUp, reach.upSystems, 'No upstream sources', reach.approxUp ?? 0)}
        {' · '}
        {orientationHalf('feeds', 'consumer', 'downstream', reach.down, reach.moreDown, reach.downSystems, 'feeds nothing downstream', reach.approxDown ?? 0)}
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
          {/* No ×N. It is the same within-model accumulator the cards
              lost — and this surface has no wire for it to live on, which
              is where a weight belongs. The peek states an entity's flows
              in words, scoped to the walk. */}
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
  // Connections, not rows: the column header counts them, the focal
  // card counts them, and a row states its own ×N. One unit, so the
  // three numbers on screen add up.
  const groupConnections = group.rows.reduce((n, r) => n + r.weight, 0)
  return (
    <div className="mb-2.5">
      <div className="flex items-center gap-1 mb-1 min-w-0">
        <button
          type="button"
          onClick={() => setToggled(t => !t)}
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${group.rows.length} entit${group.rows.length === 1 ? 'y' : 'ies'}` : 'Collapse group'}
          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-left bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.07] transition-colors"
        >
          <LucideIcons.ChevronDown className={cn('w-4 h-4 flex-shrink-0 text-ink-muted transition-transform', collapsed && '-rotate-90')} />
          <LucideIcons.FolderTree className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/70" />
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: parentColor }} />
          <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{group.label}</span>
          <span
            className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-[10px] font-semibold tabular-nums text-ink-muted"
            title={`${groupConnections} connection${groupConnections === 1 ? '' : 's'} from ${group.rows.length} entit${group.rows.length === 1 ? 'y' : 'ies'}`}
          >
            {groupConnections}
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
