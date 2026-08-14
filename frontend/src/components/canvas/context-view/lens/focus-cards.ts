/**
 * focus-cards — the CARD CONTRACT the Lineage Lens draws.
 *
 * What a built lens picture IS: cards, edges, the geometry that stacks
 * them, and the small vocabulary they are described in. Deliberately
 * framework-free (no React, no React Flow) and builder-free — this file
 * knows nothing about where a picture comes from.
 *
 * It sits between `focus-layout.ts` (which BUILDS a picture out of the
 * walk model) and `FocusGraphView.tsx` (which RENDERS one). Both used to
 * reach into the old neighbor-record builder for these definitions, so
 * deleting that builder would have taken the contract with it. The
 * contract outlives the builder: it belongs here.
 */
import type { LineageNode } from '@/store/canvas'
import { relationshipLabel } from '@/lib/relationshipLabel'

/** Ontology wording for edge types, keyed by UPPERCASE id: the
 *  schema's display name + description when defined. */
export type EdgeTypeInfoMap = Map<string, { label: string; description?: string }>

/** Human wording for a normalized edge type — the ontology's display
 *  name when defined, a readable fallback otherwise ("FLOWS_TO" →
 *  "Flows to"). Raw ids are engineer-speak; every lens surface uses this
 *  so the wording never drifts. */
export const edgeLabelFor = (norm: string, info?: EdgeTypeInfoMap): string =>
  norm ? (info?.get(norm)?.label ?? relationshipLabel(norm)) : 'relationship'

/** How far up the containment chain a card's provenance ribbon walks. */
export const ANCESTRY_CAP = 6

/** Children per page inside a frame.
 *
 *  Sized so the frame stays a CARD, not a column. At 12/20 one page of
 *  a wide table came out ~1,030px tall — the viewport's fitView then
 *  zoomed to ~0.4 and every label on the board became unreadable. The
 *  fixed window stopped the frame growing per click; it also has to be
 *  small enough that the frame is legible next to the focal. */
export const FRAME_CHILD_CAP = 8
/** Same, but in "show all children" mode — rows are shorter there, so a
 *  couple more fit in the same height. */
export const FRAME_ALL_CAP = 10

export const FRAME_HEADER_H = 46
/** The Prev · page N of M · Next strip, present only when there is more
 *  than one page. */
export const FRAME_FOOTER_H = 26
export const FRAME_PAD = 10

/** Placeholder type for an entity the lens could not resolve. Named so
 *  grain comparisons can recognise it instead of silently treating it
 *  as a real type that nothing is coarser than. */
export const UNRESOLVED_TYPE = 'not loaded'

export const CARD_W = 240
/** Content width inside a frame. Wider than a band card because a
 *  frame's header carries the container's name PLUS the Connected|All
 *  toggle, a Find box, a hop and a Focus control — at plain CARD_W the
 *  name truncated to "s..." and the frame lost its identity, which is
 *  the single most important thing it states. Kept small enough that
 *  two levels of nesting still fit inside one band slot
 *  (CARD_W + BAND_GAP). */
export const FRAME_CONTENT_W = CARD_W + 50
export const FOCAL_H = 120
export const CARD_H = 64
/** A frame row with nothing to say beneath its name — its relationship
 *  is stated once on the frame, and it stands for no coarser grain.
 *  Sized to the name alone rather than to a subtitle that will not
 *  render. `rowHeight` below is the single place that decides. */
export const CHILD_ROW_H = 36

/** How tall a row inside a frame must be.
 *
 *  A row prints a subtitle only when it has something the frame has not
 *  already said: a relationship its siblings do not share. Otherwise the
 *  name is the whole row. */
export function rowHeight(sharedEdgeType: string, ownEdgeType: string): number {
  return ownEdgeType !== '' && ownEdgeType !== sharedEdgeType ? CARD_H : CHILD_ROW_H
}
export const BAND_GAP = 130
export const CARD_GAP = 10
/** Indent for cards hanging below the focal in its own band. */
export const NEST_INDENT = 16
/** Vertical gap between the focal card and anything stacked under it. */
export const CONTAINS_STACK_GAP = 18

/**
 * What a frame's pager knows — derived, so the layout that reserves the
 * footer's room and the view that draws it can never disagree.
 *
 * `pageCount` is a FLOOR whenever `exact` is false: with pages still on
 * the server the honest statement is "of 6+", not a guess at the rest.
 */
export function framePager(card: FocusCard) {
  const size = Math.max(1, card.framePageSize)
  // `frameTotal` is the CONTAINER's child count — every column of the
  // table, not the connected ones. It only describes the frame's extent
  // in "everything inside" mode. Applying it in Connected mode said
  // "3 connected · showing 1–12 of 428 · page 1 of 36" over three rows,
  // with 35 pages that hold nothing and a Next that could not move
  // (Connected mode has no further pages to fetch).
  const exact = card.frameShowingAll ? card.frameTotal >= 0 : true
  // Rows the frame can actually reach. In "all" mode the connected
  // children are appended to the server's child list, so the roster can
  // run past the container's own count; paging to `frameTotal` alone
  // would strand them on a page that does not exist.
  const rows = card.frameShowingAll
    ? Math.max(card.frameLoaded, card.frameTotal >= 0 ? card.frameTotal : 0)
    : card.frameLoaded
  const from = rows === 0 ? 0 : card.framePage * size + 1
  const to = Math.min(card.framePage * size + size, rows)
  const pageCount = Math.max(1, Math.ceil(rows / size))
  const hasMore = card.frameShowingAll && card.frameHasMore
  return {
    rows,
    from,
    to,
    pageCount,
    exact,
    paged: pageCount > 1 || hasMore,
    canPrev: card.framePage > 0,
    canNext: to < rows || hasMore,
  }
}

export type FocusCardKind = 'focal' | 'entity' | 'frame'

/**
 * The ⊕ on a card, in exactly one of three states — and the state
 * is the whole point, because they cost different things and promise
 * different things:
 *
 *   reveal — neighbours ALREADY in the walk model that this page has not
 *            shown yet. Costs nothing to click, and the count is exact.
 *   extend — the server says more exists BEYOND the model. `count` is the
 *            exact remainder when it reported a total, and null when it
 *            genuinely does not know — never a fabricated number.
 *   page   — the server handed back a cursor for a partial adjacency;
 *            `cursor` is carried verbatim and never interpreted.
 *
 * `key` is `${'in'|'out'}:${urn}` naming the node the click acts on.
 */
export interface FocusPill {
  kind: 'reveal' | 'extend' | 'page'
  count: number | null
  key: string
  cursor?: string
  status?: 'loading' | 'error'
}

/**
 * How far a walk has reached, for the focal card's reach line.
 *
 * Not a measurement of its own — these are the entities the data source
 * has NAMED as upstream / downstream of the focus, which is the same
 * model every other number on the board comes from. The old strip ran a
 * bounded transitive trace instead, so it counted different things from
 * everything beside it and no reader could reconcile the two.
 */
export interface LensReach {
  up: number
  down: number
  /** A frontier is still open on THIS side (or a fetch was capped), so
   *  the count beside it is a floor rather than a total. Per-direction
   *  on purpose: one flag for both stamped "0+ downstream" on a focal
   *  whose downstream the data source had plainly reported as empty,
   *  right beside the whisper saying so. */
  moreUp: boolean
  moreDown: boolean
}

export interface FocusCard {
  /** Stable across rebuilds so shared cards glide between focal swaps:
   *  'f' | n:urn | fr:urn */
  id: string
  kind: FocusCardKind
  /** Backing entity urn. */
  nodeId: string | null
  band: number
  x: number
  y: number
  w: number
  h: number
  label: string
  /** Entity description when known — hover context for business users. */
  description: string | null
  /** Entity type id; 'not loaded' when the walk could not resolve one. */
  type: string
  parentId: string | null
  parentLabel: string | null
  /** Raw hops this card's subtree carries to the rest of the picture. */
  count: number
  /** The one relationship type this card's hops share, '' when they
   *  differ or it carries none. */
  edgeTypeNorm: string
  /** Frame this card is nested inside (`fr:${urn}`), else null. */
  frameId: string | null
  /** Nesting level, 0 for a top-level card. Drives the indent; the tree
   *  itself is derived, never stored. */
  depth: number
  /** Frame cards only — opened, and nothing inside connects to the focal. */
  frameEmpty: boolean
  /** Frame CHILD only: is this on the lineage? False for a child that
   *  merely lives inside the container, shown in "all" mode so the
   *  picture is the whole table rather than an edited version. */
  connected: boolean
  /** Frame cards only — showing every child, not just connected ones. */
  frameShowingAll: boolean
  /** Frame cards only — how many of the shown children connect. */
  frameConnectedCount: number
  /** Frame cards only — children fetched so far. */
  frameLoaded: number
  /** Frame cards only — the container's real child count, or -1 when
   *  genuinely unknown (render a floor, never a fabricated total). */
  frameTotal: number
  /** Frame cards only — more children exist on the server than loaded. */
  frameHasMore: boolean
  /** Frame cards only — the one relationship type ALL its rows carry,
   *  or '' when they differ.
   *
   *  Eight rows each reading `● DERIVES FROM` is eight identical lines
   *  that say nothing and crowd out the name; the frame states it once
   *  instead. Decided in the builder rather than in the view because it
   *  also decides the row HEIGHT — a row with nothing to put in a
   *  subtitle needs 36px, not 64 — and a view that suppressed what the
   *  layout had reserved room for is how the 1,030px frame happened. */
  frameSharedEdgeType: string
  /** The containment chain ABOVE this entity, root-first, as labels —
   *  `['Snowflake', 'GOLD', 'fact_orders']`. One truncated parent could
   *  not tell `int_clean_orders_t1` from `int_clean_orders_t2`, which is
   *  precisely the "where does this column come from" complaint. */
  ancestry: string[]
  /** The same chain as urns, so each crumb is a place you can go. */
  ancestryIds: string[]
  /** Frame cards only — which page of children is on screen (0-based),
   *  already clamped to what has actually loaded. Paging shows ONE page
   *  at a time so a 500-column table and a 5-column one occupy the same
   *  room: raising a cap instead grew the frame past ~2,000px and
   *  multiplied the card count with every click. */
  framePage: number
  /** Frame cards only — children per page. */
  framePageSize: number
  /** This entity can hold things, so it offers to open its contents.
   *  Independent of the ⊕: "what is inside this" and "what connects to
   *  this next" are different questions and get different controls,
   *  rather than one pill whose meaning depends on grain. */
  canOpenChildren: boolean
  /** Its contents are currently open (it renders as a frame). */
  childrenOpen: boolean
  /** The key this card's open/collapse acts on. */
  expandKey: string | null
  /** Frame cards: its rows are on screen. Mirrors `childrenOpen`. */
  expanded: boolean
  /** The walk reached this card and NOTHING further exists beyond it —
   *  a claim about the data source, made only once the walk says so. */
  deadEnd: boolean
  fetch: 'loading' | 'error' | null
  /** Text-filter miss — rendered dimmed, never removed. */
  dimmed: boolean
  /** The ⊕ on this card's upstream side, or null when drained. */
  pillUp: FocusPill | null
  /** The ⊕ on this card's downstream side, or null when drained. */
  pillDown: FocusPill | null
  /** What is inside, at the two grains that matter: how many of its
   *  contents are ON THIS LINEAGE, and how many it holds in total (null
   *  when the count is genuinely unknown — a floor is not a total). */
  contents: { onLineage: number; total: number | null } | null
}

export interface FocusEdge {
  id: string
  /** Card ids; source is the upstream side — data always flows L→R. */
  source: string
  target: string
  count: number
  edgeTypeNorm: string
  dimmed: boolean
  /** This hop runs BACKWARDS in the picture's own hop numbering, so it
   *  closes a loop. Drawn with a cycle badge rather than silently
   *  overlapping a forward wire. */
  cycleBack: boolean
  /** This bundle's ×N badge has something to say AND somewhere to sit:
   *  more than one raw hop (or a cycle to mark), a drawn line long
   *  enough to hold a pill, and no other badge already occupying that
   *  spot. Decided here rather than in the view because it is a question
   *  about GEOMETRY, and the geometry is what this module computes —
   *  badges on short, overlapping wires read as confetti floating over
   *  the board rather than as labels belonging to a line. */
  labelVisible: boolean
}

export interface FocusGraph {
  cards: FocusCard[]
  edges: FocusEdge[]
  /** Entities removed by the type chips (reported next to the chips). */
  hiddenByChips: number
  /** Per-direction split of the above. An empty band is only a claim
   *  about the DATA SOURCE when the user's own type chips did not empty
   *  it — otherwise "No upstream sources in the data source" reports the
   *  filter as a fact. */
  hiddenByChipsIn: number
  hiddenByChipsOut: number
  /** Does the walk MODEL know of anything upstream / downstream at all —
   *  an urn the data source named, a hop it shipped, or a frontier it
   *  says is still out there?
   *
   *  The empty-direction whisper ("No upstream sources in the data
   *  source") is a claim about the DATA SOURCE, so this is what may make
   *  it — never an empty BAND. A band can be empty because the geometry
   *  put those cards somewhere else, and the whisper then contradicts
   *  the three upstream frames sitting right beside it. */
  modelHasUpstream: boolean
  modelHasDownstream: boolean
  /** Raw hops the picture could not draw because their nearest drawn end
   *  is a level it does not draw — a containment ancestor of the FOCUS
   *  that the data source also put on a hop. Said out loud on the focal
   *  ("+N connect at a coarser grain") rather than dropped in silence,
   *  and it is what explains a partner card with no wire on it. */
  hopsAtCoarserGrain: number
  /** Every containment level this view state has drawn THROUGH, this
   *  build and every earlier one. The consumer folds it back into
   *  `LensViewState.walkedThrough`; see the note there for why the grain
   *  has to be sticky. */
  walkedThrough: ReadonlySet<string>
  /** Per band key `${dir}:${band}`: cards shown vs total available. */
  bandTotals: Map<string, {
    shown: number
    total: number
    /** Connections the band's CARDS stand for. A frame is one card
     *  holding eight connected columns, so "DATA SOURCES 1" sat above
     *  eight rows beside a focal reading "11 in" — every number true,
     *  nothing on screen reconciling them. */
    connections: number
  }>
}

/** Display label for a node — the fallback chain every lens surface
 *  uses, in one place so they always agree. */
export function labelOf(id: string, node: LineageNode | undefined): string {
  const data = node?.data as Record<string, unknown> | undefined
  return (data?.label as string)
    ?? (data?.businessLabel as string)
    // URN-derived fallback for an as-yet-unresolved neighbor. Split on
    // structural punctuation too (`,` `(` `)`) so nested URNs like
    // `urn:…:(…,field_name)` yield `field_name`, never a stray `)` or a
    // comma-joined blob.
    ?? id.split(/[:/.,()]/).filter(Boolean).pop()
    ?? id
}

/**
 * Deterministic hop-band layout, baked into the cards in place:
 * x from the band index; y by stacking each band's cards (in insertion
 * order — the builder already sorted them) centered on the focal's
 * midline (y = 0). The focal band centers the FOCAL card itself on the
 * midline and hangs anything else below it, indented by NEST_INDENT per
 * level.
 *
 * A container FRAME is one stacking unit: its own height covers its
 * children, so the children are pulled out of the band's stacking pass
 * and positioned inside the frame afterwards. That keeps the band maths
 * (and its determinism) exactly as it was.
 */
export function layoutBands(cards: FocusCard[]) {
  // Size every frame to its children first, so the band can stack it as
  // a single unit.
  const childrenByFrame = new Map<string, FocusCard[]>()
  for (const c of cards) {
    if (!c.frameId) continue
    const list = childrenByFrame.get(c.frameId)
    if (list) list.push(c)
    else childrenByFrame.set(c.frameId, [c])
  }
  // Frames nest — a column opened inside an opened table. Sizing has to
  // run DEEPEST-FIRST: an outer frame's height sums its children's, so
  // a child frame whose own height had not been computed yet would size
  // its parent short and the two would overlap.
  const frameById = new Map(cards.filter(c => c.kind === 'frame').map(c => [c.id, c]))
  const depthOf = (frame: FocusCard): number => {
    let d = 0
    let host = frame.frameId
    while (host && d < 32) { d++; host = frameById.get(host)?.frameId ?? null }
    return d
  }
  const frames = [...frameById.values()]
    .map(f => ({ f, depth: depthOf(f) }))
    .sort((a, b) => b.depth - a.depth)
  for (const { f: c } of frames) {
    const kids = childrenByFrame.get(c.id) ?? []
    const inner = kids.reduce((acc, k) => acc + k.h, 0) + CARD_GAP * Math.max(0, kids.length - 1)
    c.w = CARD_W + FRAME_PAD * 2
    // A COLLAPSED frame is its header and nothing else. Reserving a
    // body row is for a frame that is open and has none yet — loading,
    // empty, failed — which all need somewhere to say so.
    c.h = kids.length === 0 && !c.childrenOpen
      ? FRAME_HEADER_H
      : FRAME_HEADER_H + FRAME_PAD + Math.max(inner, kids.length === 0 ? CARD_H : 0) + FRAME_PAD
        + (framePager(c).paged ? FRAME_FOOTER_H : 0)
  }
  // Children FILL their frame, and a nested frame is wider still (it
  // carries its own padding), so each host widens to hold what it holds.
  for (const { f: c } of frames) {
    const kids = childrenByFrame.get(c.id) ?? []
    for (const k of kids) if (k.kind !== 'frame') k.w = FRAME_CONTENT_W
    const widest = kids.reduce((acc, k) => Math.max(acc, k.w), FRAME_CONTENT_W)
    c.w = widest + FRAME_PAD * 2
  }

  const byBand = new Map<number, FocusCard[]>()
  for (const c of cards) {
    // Frame children are placed relative to their frame, not the band.
    if (c.frameId) continue
    const list = byBand.get(c.band)
    if (list) list.push(c)
    else byBand.set(c.band, [c])
  }
  for (const [band, list] of byBand) {
    const x = band * (CARD_W + BAND_GAP)
    if (band === 0) {
      // The FOCAL card centers on the midline and owns the column's own
      // x; its contains-stack and anything else in this band hang below
      // it, indented. Keyed on the KIND rather than on position: the
      // focal is what the midline is for, and "whatever happens to be
      // first" decorated a different card entirely the one time the
      // focus went missing from its own band.
      const focal = list.find(c => c.kind === 'focal')
      let y = -(focal?.h ?? FOCAL_H) / 2
      for (const c of list) {
        const isFocal = c === focal
        c.x = isFocal ? x : x + NEST_INDENT * (c.depth + 1)
        c.y = y
        y += c.h + (isFocal ? CONTAINS_STACK_GAP : CARD_GAP)
      }
      continue
    }
    const total = list.reduce((acc, c) => acc + c.h, 0) + CARD_GAP * Math.max(0, list.length - 1)
    let y = -total / 2
    for (const c of list) {
      c.x = x
      c.y = y
      y += c.h + CARD_GAP
    }
  }

  // Frames are positioned; now lay their children out inside them —
  // OUTERMOST-FIRST, the mirror of the sizing order, so a nested frame
  // already has its own absolute position before its children read it.
  for (const { f: frame } of [...frames].reverse()) {
    const kids = childrenByFrame.get(frame.id) ?? []
    let y = frame.y + FRAME_HEADER_H
    for (const k of kids) {
      k.x = frame.x + FRAME_PAD
      k.y = y
      y += k.h + CARD_GAP
    }
  }
}
