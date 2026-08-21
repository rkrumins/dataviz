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
 * "One hop from the focus" is an edge that literally touches the focus, raw
 * or rollup. NOT "hop === 1" as the view model measures it: the view model
 * measures hops from the focus SIDE (the focus and everything inside it), so
 * on the CFO estate the columns feeding the chart read as hop 1 too — seeding
 * their hosts would open the containers AND the datasets inside them, which
 * is the "trace dumps the world on screen" failure this rebuild exists to
 * end.
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
 * actually contains the focus — and `seeded` records which happened. What it
 * deliberately does NOT key on is the model itself: a full walk arrives in
 * waves, and re-seeding on each one would wipe out everything the reader had
 * opened, over and over, while the walk finished.
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

interface SeedState {
  forFocus: string | null
  set: ReadonlySet<string>
  /** The seed came from a model that HELD the focus — so it is the real one
   *  and no later wave may replace it. False while the walk is still loading. */
  seeded: boolean
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

  const partners = new Set<string>()
  for (const e of inputs.model.lineageEdges) {
    if (e.sourceUrn === focusUrn) partners.add(e.targetUrn)
    if (e.targetUrn === focusUrn) partners.add(e.sourceUrn)
  }
  if (partners.size === 0) return seed

  // Where the VIEW anchors each partner is `buildTraceView`'s decision (the
  // canvas's own placement chain), so ask it rather than re-deriving it here.
  // Lanes and cards are independent of expansion — only `expanded`/`visible`
  // read it — so a provisional build with nothing open answers exactly this.
  const cards = new Map<string, TraceCard>()
  for (const lane of buildTraceView(inputs).lanes) {
    for (const [urn, card] of lane.cards) cards.set(urn, card)
  }
  for (const partner of partners) {
    let cursor = cards.get(partner)?.parentId ?? null
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
    forFocus: focusUrn, set: seedExpansion(a), seeded: focusInModel, pending: null,
  }))

  // Re-seed DURING RENDER. Not an effect: an effect would paint one frame of
  // the previous focus's expansion first, and `react-hooks/set-state-in-effect`
  // forbids it besides.
  //
  // A RESTORE WINS HERE. The pending picture is only honoured once the model
  // holds the focus: consuming it against the loading frame would spend it on
  // a render that draws nothing, and the real seed a frame later would then
  // wipe out the very picture the reader pressed Back for.
  let traceExpansion = seed.set
  if (seed.forFocus !== focusUrn || (!seed.seeded && focusInModel)) {
    const restore = seed.pending?.forFocus === focusUrn && focusInModel ? seed.pending : null
    traceExpansion = restore ? restore.set : seedExpansion(a)
    // A pending restore belongs to the navigation that issued it. Landing on
    // a DIFFERENT focus means the reader abandoned that navigation, so it is
    // dropped rather than left armed to fire on some later, unrelated visit
    // to the focus it named. It survives only while its own focus is still
    // the one on screen, waiting for a model that holds it.
    const superseded = seed.forFocus !== focusUrn && seed.pending?.forFocus !== focusUrn
    setSeed({
      forFocus: focusUrn,
      set: traceExpansion,
      seeded: focusInModel,
      pending: restore || superseded ? null : seed.pending,
    })
  }

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
    if (!next.delete(id)) next.add(id)
    return { ...prev, set: next }
  }), [])

  const expandPath = useCallback((ids: readonly string[]) => setSeed(prev => ({
    ...prev,
    set: new Set([...prev.set, ...ids]),
  })), [])

  // Already showing that focus, already seeded: nothing to wait for, so the
  // picture goes straight on screen (this is the "resume the trace you are
  // already in" case, where no focus change would ever re-run the seed).
  const restoreExpansion = useCallback((forFocus: string, ids: readonly string[]) => setSeed(prev => (
    prev.forFocus === forFocus && prev.seeded
      ? { ...prev, set: new Set(ids), pending: null }
      : { ...prev, pending: { forFocus, set: new Set(ids) } }
  )), [])

  // Drops the expansion. The caller clears its own focus alongside — leaving
  // the focus in place re-seeds on the very next render, by design: exiting a
  // trace that is still focused somewhere is not a state the canvas has.
  const exit = useCallback(() => setSeed({ forFocus: null, set: EMPTY_EXPANSION, seeded: false, pending: null }), [])

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
