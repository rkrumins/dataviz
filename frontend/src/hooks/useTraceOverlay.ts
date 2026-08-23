/**
 * useTraceOverlay — the ONLY React state the trace overlay owns: what the
 * reader has opened. Everything else on screen is a pure function of that
 * expansion and the walk model (`buildTraceView`), so a trace never writes to
 * the canvas store and never re-lays-out the canvas behind it.
 *
 * THE SEED. A trace that lands with the focus buried inside a closed lane
 * root — or with its direct partners hidden inside one — is a trace the
 * reader has to go hunting through. So the seed opens two things:
 *
 *  • the focus's own containment chain, so the focus and its contents are on
 *    screen the moment the walk lands;
 *  • for every partner ONE HOP from the focus, the hosts between that partner
 *    and its lane root — because the view decides where a chain anchors, and
 *    when it anchors ABOVE the partner (the platform placed, the containers
 *    below it) the partner is a depth-1 child of a closed root.
 *
 * The partners themselves stay CLOSED. R1: a trace opens the way TO things,
 * never the things themselves — the chevron and its honest count are the
 * invitation.
 *
 * "One hop from the focus" is measured off the FOCUS SIDE — the focus and
 * everything inside it — exactly as the view model and the wire ledger
 * measure it: a partner is the far end of a hop with one end inside the
 * focus side and the other outside. A table carries no lineage of its own,
 * its columns do; measured off the focus node alone (as this used to be)
 * a traced table found no partners at all and every partner table stayed
 * hidden behind its closed lane root — the user's report: "tracing a table
 * shows gaps that tracing one of its columns does not" (2026-08-21).
 *
 * What opens is the way TO the partner's CARD, never the card: a partner
 * with contents is its own card; a partner leaf (a column) is stood for by
 * its parent. The hosts between that card and its lane root open; the card
 * lands closed with its honest count. That is why this does not "dump the
 * world on screen": the columns feeding the CFO chart open the warehouse
 * containers and leave the datasets shut.
 *
 * The seed is DERIVED STATE keyed by the focus: re-seeded during render when
 * `focusUrn` changes (React's "adjusting state on prop change"), never in an
 * effect. Any other input changing — a direction toggle, a depth, a layer
 * edit — leaves the reader's expansion exactly as they left it.
 *
 * AND IT WAITS FOR A MODEL THAT HOLDS THE FOCUS. The canvas sets `focusUrn`
 * the instant the reader presses Trace, while the walk hook hands back a
 * LOADING entry carrying an EMPTY model — non-null, so a seed keyed on the
 * focus alone fires immediately, seeds nothing but the focus itself over an
 * empty graph, and latches. The trace then lands with every chain closed. It
 * would read as a flake, too: a re-trace of a cached focus has its model in
 * hand on the first render and seeds perfectly.
 *
 * So the latch has TWO conditions — a new focus, or a first model that
 * actually contains the focus — and `seeded` records which happened.
 *
 * AND IT KEEPS UP WITH THE WALK. A full walk arrives in waves, and a partner
 * that lands in the third wave is as much a partner as one that landed in
 * the first — so every later wave ADDS the hosts its new partners need.
 * It only ever adds: nothing the reader opened closes, and nothing the
 * reader CLOSED (recorded by `toggle`) re-opens, however many waves follow.
 *
 * AND ONE THING OUTRANKS THE SEED: a history restore. Pressing Back names a
 * focus AND the picture the reader left on it, at a moment when that focus's
 * walk has not landed — so `restoreExpansion` records it as PENDING for that
 * focus and the seed branch consumes it instead of seeding. Without that the
 * two would race, and the seed (running a frame later, when the model lands)
 * would win every time.
 */
import { useCallback, useMemo, useState } from 'react'
import { buildTraceView, type TraceCard, type TraceView, type TraceViewInputs } from './lib/traceViewModel'
import { buildLensSubgraph, focusAncestorChain } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

export interface UseTraceOverlayArgs {
  model: LensWalkModel | null
  focusUrn: string | null
  layers: ViewLayerConfig[]
  assignments: Record<string, { layerId: string }>
  viewIsCurated: boolean
  showUpstream: boolean
  showDownstream: boolean
  depthUp: number
  depthDown: number
  /** The rest of the canvas's placement chain, passed straight through so the
   *  overlay anchors a node exactly where the canvas behind it would. */
  placement?: TraceViewInputs['placement']
}

export interface TraceOverlay {
  /** The overlay is DRAWING. False until the walk hands back a model that
   *  actually contains the focus — see `useTraceOverlay`'s "no blank canvas"
   *  note — so the canvas keeps showing browse for the whole walk rather
   *  than emptying out and filling back in. */
  active: boolean
  view: TraceView | null
  traceExpansion: ReadonlySet<string>
  /** Flip one card open/closed. No fetch in Stage 1 — the walk model already
   *  holds every participant, so expanding is a re-projection. */
  toggle(id: string): void
  /** Reveal/search: open a whole chain at once. Additive. */
  expandPath(ids: readonly string[]): void
  /** History restore: REPLACE the expansion with the picture the reader
   *  left on `forFocus`. Issued the moment Back is pressed, which is
   *  BEFORE the walk for that focus has landed — so when it names a focus
   *  this overlay is not showing yet (or is still loading), it is held as
   *  pending and wins over the seed the instant the model arrives. An
   *  empty `ids` is a legitimate restore of "nothing open". */
  restoreExpansion(forFocus: string, ids: readonly string[]): void
  /** The containment chain that has to be open for `id` to be on screen:
   *  its ancestors within its lane, nearest first, `id` itself excluded.
   *  Empty for a lane root, for an unknown urn, and while inactive — a
   *  reveal of something this trace does not hold opens nothing rather than
   *  going to fetch it. Pure; pass it to `expandPath` to act on it. */
  revealPath(id: string): string[]
  exit(): void
}

const EMPTY_EXPANSION: ReadonlySet<string> = new Set<string>()
/** Above this many lineage-bearing direct children, a traced container lands
 *  closed rather than auto-opened (see seedExpansion). */
export const FOCUS_AUTO_OPEN_MAX = 10

interface SeedState {
  forFocus: string | null
  set: ReadonlySet<string>
  /** The seed came from a model that HELD the focus — so it is the real one
   *  and no later wave may replace it. False while the walk is still loading. */
  seeded: boolean
  /** What the reader shut on this focus with `toggle` — no later wave
   *  re-opens it. */
  closed: ReadonlySet<string>
  /** The picture a history restore put back, when one did: authoritative,
   *  so whatever the seed would open that it leaves out counts as shut. */
  restored: ReadonlySet<string> | null
  /** A history restore waiting for its focus's model. Consumed — once — by
   *  the same render-time branch that would otherwise seed. */
  pending: { forFocus: string; set: ReadonlySet<string> } | null
}

function viewInputs(a: UseTraceOverlayArgs, traceExpansion: ReadonlySet<string>): TraceViewInputs | null {
  if (!a.model || !a.focusUrn) return null
  return {
    model: a.model,
    focusUrn: a.focusUrn,
    layers: a.layers,
    assignments: a.assignments,
    viewIsCurated: a.viewIsCurated,
    traceExpansion,
    showUpstream: a.showUpstream,
    showDownstream: a.showDownstream,
    depthUp: a.depthUp,
    depthDown: a.depthDown,
    placement: a.placement,
  }
}

/** The focus chain, plus the hosts between each hop-1 partner and its lane
 *  root. See the file header for why "hop-1" is measured off the focus node
 *  itself rather than off the view model's hop. */
/**
 * A RESTORED PICTURE IS CLOSED UNDER ITS HOSTS (2026-08-23).
 *
 * A card cannot be on screen unless every container between it and its lane
 * root is open, and a set that names the card but not those containers
 * restores to nothing at all — the lane roots sit closed and the picture the
 * reader was promised never appears. Restores come from outside this session
 * (a shared link, whose cap trims the very biggest pictures; a history entry
 * written by an older build), so the set is completed here rather than
 * trusted.
 *
 * Parents come from `buildTraceView` for the same reason `seedExpansion`
 * asks it: where a card is anchored is the view's decision, not raw
 * containment's. One provisional build, on the frame a restore lands.
 */
function withHosts(a: UseTraceOverlayArgs, ids: ReadonlySet<string>): ReadonlySet<string> {
  if (ids.size === 0) return ids
  const inputs = viewInputs(a, EMPTY_EXPANSION)
  if (!inputs) return ids
  const parents = new Map<string, string | null>()
  for (const lane of buildTraceView(inputs).lanes) {
    for (const [urn, card] of lane.cards) parents.set(urn, card.parentId)
  }
  // The FOCUS's own hosts are walked too, without opening the focus itself:
  // a trace that does not show the entity it is about is not a picture worth
  // restoring, and whether the focus opens is `seedExpansion`'s call (a
  // container with a hundred children lands closed).
  const out = new Set(ids)
  for (const id of [...ids, inputs.focusUrn]) {
    let cursor = parents.get(id) ?? null
    while (cursor && !out.has(cursor)) {
      out.add(cursor)
      cursor = parents.get(cursor) ?? null
    }
  }
  return out
}

function seedExpansion(a: UseTraceOverlayArgs): ReadonlySet<string> {
  const inputs = viewInputs(a, EMPTY_EXPANSION)
  if (!inputs) return EMPTY_EXPANSION
  const focusUrn = inputs.focusUrn

  const sg = buildLensSubgraph({
    focusUrn,
    nodes: inputs.model.nodes,
    lineageEdges: [],                       // containment is all the chain needs
    containmentEdges: inputs.model.containmentEdges,
    frontierUp: [],
    frontierDown: [],
  })
  const seed = new Set<string>([...focusAncestorChain(sg), focusUrn])

  // Where the VIEW anchors each card is `buildTraceView`'s decision (the
  // canvas's own placement chain), so ask it rather than re-deriving it here.
  // Lanes and cards are independent of expansion — only `expanded`/`visible`
  // read it — so a provisional build with nothing open answers exactly this.
  const cards = new Map<string, TraceCard>()
  for (const lane of buildTraceView(inputs).lanes) {
    for (const [urn, card] of lane.cards) cards.set(urn, card)
  }

  // The focus itself opens only when what is inside it is small enough to
  // read at a glance. A table or container traced with a hundred
  // lineage-bearing children lands CLOSED — its pill says "N on this
  // lineage", its wires roll up to it, and one click opens it — instead of
  // a wall of rows. Decided BEFORE the partner walk: a table whose edges
  // touch its columns has no direct partners of its own.
  let focusKids = 0
  for (const card of cards.values()) if (card.parentId === focusUrn) focusKids += 1
  if (focusKids > FOCUS_AUTO_OPEN_MAX) seed.delete(focusUrn)

  // The focus SIDE: the focus and everything inside it (see the header).
  const focusSide = new Set<string>([focusUrn])
  const stack = [...(sg.nodes.get(focusUrn)?.children ?? [])]
  while (stack.length > 0) {
    const urn = stack.pop()!
    if (focusSide.has(urn)) continue
    focusSide.add(urn)
    for (const child of sg.nodes.get(urn)?.children ?? []) stack.push(child)
  }
  const partners = new Set<string>()
  for (const e of inputs.model.lineageEdges) {
    const sourceIn = focusSide.has(e.sourceUrn)
    if (sourceIn === focusSide.has(e.targetUrn)) continue   // internal, or not ours
    partners.add(sourceIn ? e.targetUrn : e.sourceUrn)
  }
  if (partners.size === 0) return seed

  for (const partner of partners) {
    const partnerCard = cards.get(partner)
    if (!partnerCard) continue
    // The card that stands for the partner: itself when it has contents,
    // its parent when it is a leaf. The hosts ABOVE that card open.
    const cardId = partnerCard.childCount > 0 || (sg.nodes.get(partner)?.children.length ?? 0) > 0
      ? partner
      : partnerCard.parentId
    let cursor = cardId ? cards.get(cardId)?.parentId ?? null : null
    while (cursor && !seed.has(cursor)) {
      seed.add(cursor)
      cursor = cards.get(cursor)?.parentId ?? null
    }
  }
  return seed
}

export function useTraceOverlay(a: UseTraceOverlayArgs): TraceOverlay {
  // Field by field: the canvas re-creates the args object every render, so a
  // memo over `a` itself would rebuild the view on every unrelated keystroke.
  // `placement` is unpacked for the same reason — the canvas rebuilds that
  // object too, and depending on it would undo the whole point.
  const { model, focusUrn, layers, assignments, viewIsCurated } = a
  const { showUpstream, showDownstream, depthUp, depthDown } = a
  const { backendAssignments, unassignedFallbackLayerId, branchCreatedUrns } = a.placement ?? {}

  // O(n) over the walk's nodes, but only when the model or the focus changes
  // — which is exactly when the answer can change.
  const focusInModel = useMemo(
    () => !!focusUrn && !!model && model.nodes.some(n => n.urn === focusUrn),
    [model, focusUrn],
  )

  const [seed, setSeed] = useState<SeedState>(() => ({
    forFocus: focusUrn, set: seedExpansion(a), seeded: focusInModel, closed: EMPTY_EXPANSION, restored: null, pending: null,
  }))

  // Re-seed DURING RENDER. Not an effect: an effect would paint one frame of
  // the previous focus's expansion first, and `react-hooks/set-state-in-effect`
  // forbids it besides.
  //
  // A RESTORE WINS HERE. The pending picture is only honoured once the model
  // holds the focus: consuming it against the loading frame would spend it on
  // a render that draws nothing, and the real seed a frame later would then
  // wipe out the very picture the reader pressed Back for.
  let stored = seed.set
  let restored = seed.restored
  // ONE consumption point for every restore, whenever the model can honour
  // it — including a restore issued for the focus already on screen. Both
  // roads then run through `withHosts`, so a picture is completed the same
  // way whether it arrived before the walk or after it.
  const honourable = seed.pending?.forFocus === focusUrn && focusInModel
  if (seed.forFocus !== focusUrn || (!seed.seeded && focusInModel) || honourable) {
    const restore = honourable ? seed.pending : null
    stored = restore ? withHosts(a, restore.set) : seedExpansion(a)
    restored = restore ? stored : null
    // A pending restore belongs to the navigation that issued it. Landing on
    // a DIFFERENT focus means the reader abandoned that navigation, so it is
    // dropped rather than left armed to fire on some later, unrelated visit
    // to the focus it named. It survives only while its own focus is still
    // the one on screen, waiting for a model that holds it.
    const superseded = seed.forFocus !== focusUrn && seed.pending?.forFocus !== focusUrn
    setSeed({
      forFocus: focusUrn,
      set: stored,
      seeded: focusInModel,
      closed: EMPTY_EXPANSION,
      restored,
      pending: restore || superseded ? null : seed.pending,
    })
  }

  // KEEPING UP WITH THE WALK. What a wave adds is DERIVED, never stored: the
  // hosts the current model's partners need, minus what the reader shut.
  // Stored state would need a render-time write per wave, and a canvas that
  // hands over a fresh model object per render would loop on it. Memoised
  // on the model, so the O(model) seed runs once per wave.
  const seedNow = useMemo(() => (
    focusInModel
      ? seedExpansion({ model, focusUrn, layers, assignments, viewIsCurated, showUpstream, showDownstream, depthUp, depthDown,
        placement: { backendAssignments, unassignedFallbackLayerId, branchCreatedUrns } })
      : EMPTY_EXPANSION
  ), [model, focusUrn, layers, assignments, viewIsCurated, showUpstream, showDownstream, depthUp, depthDown,
    backendAssignments, unassignedFallbackLayerId, branchCreatedUrns, focusInModel])
  const closed = seed.closed
  const traceExpansion = useMemo(() => {
    let next: Set<string> | null = null
    for (const id of seedNow) {
      // Shut by a click, or left out of the picture a restore put back.
      if (stored.has(id) || closed.has(id) || (restored && !restored.has(id))) continue
      next ??= new Set(stored)
      next.add(id)
    }
    return next ?? stored
  }, [seedNow, stored, closed, restored])

  // NO BLANK CANVAS. `model` is non-null from the first render of a walk —
  // the walk hook hands back a LOADING entry carrying an EMPTY one — so an
  // overlay that went live on `!!model` would blank every column for the
  // length of the walk and then fill them back in. It goes live only once
  // the model actually CONTAINS the focus; until then the canvas keeps
  // rendering browse and the dock carries the loading state.
  const active = !!focusUrn && !!model && focusInModel

  const view = useMemo<TraceView | null>(() => (
    active && model && focusUrn
      ? buildTraceView({
        model, focusUrn, layers, assignments, viewIsCurated, traceExpansion,
        showUpstream, showDownstream, depthUp, depthDown,
        placement: { backendAssignments, unassignedFallbackLayerId, branchCreatedUrns },
      })
      : null
  ), [active, model, focusUrn, layers, assignments, viewIsCurated, traceExpansion,
    showUpstream, showDownstream, depthUp, depthDown,
    backendAssignments, unassignedFallbackLayerId, branchCreatedUrns])

  const toggle = useCallback((id: string) => setSeed(prev => {
    const next = new Set(prev.set)
    const closed = new Set(prev.closed)
    if (next.delete(id)) closed.add(id)
    else { next.add(id); closed.delete(id) }
    return { ...prev, set: next, closed }
  }), [])

  const expandPath = useCallback((ids: readonly string[]) => setSeed(prev => ({
    ...prev,
    set: new Set([...prev.set, ...ids]),
  })), [])

  // Already showing that focus, already seeded: nothing to wait for, so the
  // picture goes straight on screen (this is the "resume the trace you are
  // already in" case, where no focus change would ever re-run the seed).
  /** Put a picture back — from history, or from a shared link. Always
   *  recorded as PENDING: the render-time branch above is the one place that
   *  knows the model, and so the one place that can complete the set with the
   *  hosts each named card needs. It is consumed on the next render when the
   *  model holds the focus, and waits when it does not. */
  const restoreExpansion = useCallback((forFocus: string, ids: readonly string[]) => setSeed(prev => (
    { ...prev, pending: { forFocus, set: new Set(ids) } }
  )), [])

  // Drops the expansion. The caller clears its own focus alongside — leaving
  // the focus in place re-seeds on the very next render, by design: exiting a
  // trace that is still focused somewhere is not a state the canvas has.
  const exit = useCallback(() => setSeed({ forFocus: null, set: EMPTY_EXPANSION, seeded: false, closed: EMPTY_EXPANSION, restored: null, pending: null }), [])

  // Lanes are independent of each other, so the first one holding the card
  // is the only one that can hold its chain.
  const revealPath = useCallback((id: string): string[] => {
    for (const lane of view?.lanes ?? []) {
      if (!lane.cards.has(id)) continue
      const chain: string[] = []
      let cursor = lane.cards.get(id)?.parentId ?? null
      while (cursor && !chain.includes(cursor)) {
        chain.push(cursor)
        cursor = lane.cards.get(cursor)?.parentId ?? null
      }
      return chain
    }
    return []
  }, [view])

  return { active, view, traceExpansion, toggle, expandPath, restoreExpansion, revealPath, exit }
}
