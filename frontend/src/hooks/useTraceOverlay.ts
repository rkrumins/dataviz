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
  active: boolean
  view: TraceView | null
  traceExpansion: ReadonlySet<string>
  /** Flip one card open/closed. No fetch in Stage 1 — the walk model already
   *  holds every participant, so expanding is a re-projection. */
  toggle(id: string): void
  /** Reveal/search: open a whole chain at once. Additive. */
  expandPath(ids: readonly string[]): void
  exit(): void
}

const EMPTY_EXPANSION: ReadonlySet<string> = new Set<string>()

interface SeedState {
  forFocus: string | null
  set: ReadonlySet<string>
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
  const { model, focusUrn, layers, assignments, viewIsCurated } = a
  const { showUpstream, showDownstream, depthUp, depthDown, placement } = a

  const [seed, setSeed] = useState<SeedState>(() => ({ forFocus: focusUrn, set: seedExpansion(a) }))

  // Re-seed DURING RENDER when the focus changes. Not an effect: an effect
  // would paint one frame of the previous focus's expansion first, and
  // `react-hooks/set-state-in-effect` forbids it besides.
  let traceExpansion = seed.set
  if (seed.forFocus !== focusUrn) {
    traceExpansion = seedExpansion(a)
    setSeed({ forFocus: focusUrn, set: traceExpansion })
  }

  const view = useMemo<TraceView | null>(() => (
    model && focusUrn
      ? buildTraceView({
        model, focusUrn, layers, assignments, viewIsCurated, traceExpansion,
        showUpstream, showDownstream, depthUp, depthDown, placement,
      })
      : null
  ), [model, focusUrn, layers, assignments, viewIsCurated, traceExpansion,
    showUpstream, showDownstream, depthUp, depthDown, placement])

  const toggle = useCallback((id: string) => setSeed(prev => {
    const next = new Set(prev.set)
    if (!next.delete(id)) next.add(id)
    return { ...prev, set: next }
  }), [])

  const expandPath = useCallback((ids: readonly string[]) => setSeed(prev => ({
    ...prev,
    set: new Set([...prev.set, ...ids]),
  })), [])

  // Drops the expansion. The caller clears its own focus alongside — leaving
  // the focus in place re-seeds on the very next render, by design: exiting a
  // trace that is still focused somewhere is not a state the canvas has.
  const exit = useCallback(() => setSeed({ forFocus: null, set: EMPTY_EXPANSION }), [])

  return { active: !!focusUrn && !!model, view, traceExpansion, toggle, expandPath, exit }
}
