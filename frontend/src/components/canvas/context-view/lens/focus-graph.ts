/**
 * focus-graph — pure builder for the Lens's interactive Graph mode.
 *
 * Turns the focal node's neighbor records (plus any expanded hops) into
 * positioned cards and edges for a DataHub-style hop-band layout:
 * focal at band 0, direct upstream at band -1, downstream at +1, and
 * user-expanded hops at ±2..±MAX_BAND. Everything here is deliberately
 * framework-free (no React, no React Flow) so the entire graph
 * semantics — grouping, rollups, opening a container into its
 * focal-relevant contents, frontier expansion, caps, filters, layout —
 * is unit-testable in plain functions.
 *
 * Honesty rules carried over from the list body:
 *  - band caps surface as an explicit "+N more" overflow card and
 *    per-band shown/total counts — never silent truncation;
 *  - the text filter DIMS non-matching cards (and reports matches
 *    hidden inside collapsed groups) — it never removes them;
 *  - type chips REMOVE cards but the removed count is reported;
 *  - an opened container reports what it capped, and its contents come
 *    from the server's pair-filtered expansion — entities that don't
 *    participate in lineage with the focal never appear.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { deriveNeighborRecords, type NeighborRecord } from '@/lib/lineage-neighbors'
import { relationshipLabel } from '@/lib/relationshipLabel'

/** Ontology wording for edge types, keyed by UPPERCASE id: the
 *  schema's display name + description when defined. */
export type EdgeTypeInfoMap = Map<string, { label: string; description?: string }>

/** Human wording for a normalized edge type — the ontology's display
 *  name when defined, a readable fallback otherwise ("FLOWS_TO" →
 *  "Flows to"). Raw ids are engineer-speak; both lens bodies use this
 *  so the wording never drifts. */
export const edgeLabelFor = (norm: string, info?: EdgeTypeInfoMap): string =>
  norm ? (info?.get(norm)?.label ?? relationshipLabel(norm)) : 'relationship'

/** Cards per band before the "+N more" overflow card (paged).
 *
 *  Sized to the VIEWPORT, not picked as a round number. A card is
 *  CARD_H 64 + CARD_GAP 10 = 74px, so a band fills a ~950px lens body at
 *  about twelve. At 30 a band of fifteen was never capped: no overflow
 *  card was emitted, five cards sat silently below the fold, and the
 *  band header printed a bare "15" over ten visible cards as the only
 *  cue that anything was missing. That is where a focal's rolled-up
 *  platform and container partners went — `rollups` is the last segment
 *  of the band, so they stack at the bottom. */
export const GRAPH_BAND_CAP = 12
/** How far up the containment chain a card's provenance ribbon walks. */
export const ANCESTRY_CAP = 6
/** Focal containment children shown before the overflow card. */
export const CONTAINS_CAP = 8
/** How deep the focal's contains stack nests before it stops offering
 *  to go further. Deep structure belongs in a frame, not in a stack
 *  hanging off the focal — and an unbounded stack can outgrow the board. */
export const CONTAINS_MAX_DEPTH = 3
/** Hard stop for hop expansion per direction. */
export const MAX_BAND = 4
/** Children per page inside an opened container frame.
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

/** Content width inside a frame. Wider than a band card because a
 *  frame's header carries the container's name PLUS the Connected|All
 *  toggle, a Find box, a hop and a Focus control — at plain CARD_W the
 *  name truncated to "s..." and the frame lost its identity, which is
 *  the single most important thing it states. Kept small enough that
 *  two levels of nesting still fit inside one band slot
 *  (CARD_W + BAND_GAP). */
export const FRAME_HEADER_H = 46
/** The Prev · page N of M · Next strip, present only when there is more
 *  than one page. */
export const FRAME_FOOTER_H = 26
export const FRAME_PAD = 10

const EMPTY_STRINGS: string[] = []
const EMPTY_SET: ReadonlySet<string> = new Set()

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
export const CONTAINS_H = 36
export const OVERFLOW_H = 36
/** A frame row with nothing to say beneath its name — its relationship
 *  is stated once on the frame, and it stands for no coarser grain.
 *  Sized to the name alone rather than to a subtitle that will not
 *  render. `rowHeight` below is the single place that decides. */
export const CHILD_ROW_H = 36

/** How tall a row inside a frame must be.
 *
 *  A row prints a subtitle only when it has something the frame has not
 *  already said: a relationship its siblings do not share, or a coarser
 *  grain it stands for. Otherwise the name is the whole row. Both frame
 *  kinds ask this, so a column inside its table is one height however
 *  the frame was built — locally from records in hand, or from a server
 *  open. */
export function rowHeight(sharedEdgeType: string, ownEdgeType: string, alsoAtGrains: readonly string[]): number {
  const saysSomethingNew = (ownEdgeType !== '' && ownEdgeType !== sharedEdgeType) || alsoAtGrains.length > 0
  return saysSomethingNew ? CARD_H : CHILD_ROW_H
}
export const BAND_GAP = 130
export const CARD_GAP = 10
/** Indent for the focal's contains-stack rows. */
export const NEST_INDENT = 16
/** Vertical gap between the focal card and its contains stack. */
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
  // children an open found are appended to the server's child list, so
  // the roster can run past the container's own count; paging to
  // `frameTotal` alone would strand them on a page that does not exist.
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

export type FocusDirection = 'in' | 'out'

export type FocusCardKind = 'focal' | 'entity' | 'contains' | 'overflow' | 'frame'

/**
 * What a card's ONE expand affordance does. Every expandable card
 * offers the same gesture — "show me what's inside / what's next" —
 * and this says which meaning applies:
 *   group → reveal the members grouped under this parent
 *   open  → open a COARSER partner (a container, a platform) into the
 *           entities inside it that carry lineage to the focal. This is
 *           what stops a coarse card being a dead end, and it is
 *           answered by the server's descendant-pair expansion — never
 *           by guessing from locally-loaded edges.
 *   hop   → fetch and reveal this entity's own next hop
 *   more  → page in the rest of a capped band or frame
 *   retry → the fetch behind this row failed; ask again
 *   focus → the stack ends here; re-center the lens on this entity so
 *           its own contents become the new top level. A door, not a
 *           wall: the alternative was a chevron that fetched and then
 *           rendered nothing.
 */
export type FocusExpandKind = 'open' | 'hop' | 'more' | 'retry' | 'focus' | null

export interface FocusCard {
  /** Stable across rebuilds so shared cards glide between focal swaps:
   *  'f' | n:urn | g:dir:parentUrn | c:urn | fr:dir:urn | more:dir:band */
  id: string
  kind: FocusCardKind
  /** Backing entity urn; null only for overflow cards. */
  nodeId: string | null
  band: number
  x: number
  y: number
  w: number
  h: number
  label: string
  /** Entity description when known — hover context for business users. */
  description: string | null
  /** Entity type id; 'entity' fallback, 'not loaded' when unresolved. */
  type: string
  parentId: string | null
  parentLabel: string | null
  /** Entity: bundled connection count (≥1). Group: member count. */
  count: number
  /** Entity: normalized type of the connecting edge ('' elsewhere). */
  edgeTypeNorm: string
  /** Group: Σ member connection counts. 0 elsewhere. */
  sumCount: number
  /** Coarser-grain summary of finer flows (dashed, badged, demoted). */
  rollup: boolean
  /** Entity not resolvable from store or fetches ("not on canvas"). */
  unresolved: boolean
  aggregated: boolean
  /** Frame this card is nested inside (`fr:${dir}:${urn}`), else null. */
  frameId: string | null
  /** Contains-stack nesting level, 0 for a direct child of the focal.
   *  Drives the indent; the tree itself is derived, never stored. */
  depth: number
  /** Frame cards only — the pass-through levels the open walked
   *  through, so a skipped level is shown rather than hidden. */
  frameBreadcrumb: string[]
  /** Frame cards only — server capped the expansion (counts are floors). */
  frameTruncated: boolean
  /** Frame cards only — opened, and nothing inside connects to the focal. */
  frameEmpty: boolean
  /** Frame CHILD only: does this carry lineage to the focal? False for a
   *  child that merely lives inside the container, shown in "all" mode
   *  so the picture is the whole table rather than an edited version. */
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
  /** Frame cards only — built from the band's OWN records rather than a
   *  server open, so its roster is complete, its filter is local, and
   *  its chevron toggles `collapsedFrames` instead of firing a fetch. */
  frameLocal: boolean
  /** Frame cards only — the one relationship type ALL its rows carry,
   *  or '' when they differ.
   *
   *  Eight rows each reading `● DERIVES FROM` is eight identical lines
   *  that say nothing and crowd out the name; the frame states it once
   *  instead. Decided here rather than in the view because it also
   *  decides the row HEIGHT — a row with nothing to put in a subtitle
   *  needs 36px, not 64 — and a view that suppressed what the layout
   *  had reserved room for is how the 1,030px frame happened. */
  frameSharedEdgeType: string
  /** The containment chain ABOVE this entity, root-first, as labels —
   *  `['Snowflake', 'GOLD', 'fact_orders']`. One truncated parent could
   *  not tell `int_clean_orders_t1` from `int_clean_orders_t2`, which is
   *  precisely the "where does this column come from" complaint. */
  ancestry: string[]
  /** The same chain as urns, so each crumb is a place you can go. */
  ancestryIds: string[]
  /** Coarser grains this card also arrived as, folded into it — the
   *  same connection restated at its ancestors' levels. Named so the
   *  card can say what it now stands for instead of silently dropping
   *  three cards the header still counts. */
  alsoAtGrains: string[]
  /** This card's expansion completed and reached only entities that
   *  were already drawn — it contributed edges, not cards. Said out
   *  loud, because otherwise the click looks like it did nothing. */
  alreadyShown: boolean
  /** Frame cards only — which page of children is on screen (0-based),
   *  already clamped to what has actually loaded. Paging shows ONE page
   *  at a time so a 500-column table and a 5-column one occupy the same
   *  room: raising a cap instead grew the frame past ~2,000px and
   *  multiplied the card count with every click. */
  framePage: number
  /** Frame cards only — children per page. */
  framePageSize: number
  /** The entities THIS card is connected to in the picture — its
   *  previous-band partners (the focal, at band 1). Opening a container
   *  must ask what inside it connects to a PARTNER: a band-2 card has
   *  no direct lineage with the focal, so anchoring the question there
   *  is answered honestly, and uselessly, with "nothing". */
  partnerIds: string[]
  /** Human name of the partner an open would ask about — NULL when that
   *  partner is the focal itself, which lets the UI keep its plain
   *  "connects to this entity" wording at the first hop and name the
   *  actual partner further out. */
  partnerLabel: string | null
  /** This entity can hold things, so it offers to open its contents.
   *  Independent of `expandKind`: "what is inside this" and "what
   *  connects to this next" are different questions and get different
   *  controls, rather than one pill whose meaning depends on grain. */
  canOpenChildren: boolean
  /** Its contents are currently open (it renders as a frame). */
  childrenOpen: boolean
  /** Group toggle key into expandedGroups / open key into
   *  openContainers / frontier key into expandedFrontier. All three are
   *  `${dir}:${urn}`, so one key serves whichever set applies. */
  expandKey: string | null
  /** True when this group card is currently expanded (header form). */
  expanded: boolean
  /** What this card's expand affordance means (null = not expandable). */
  expandKind: FocusExpandKind
  /** Card shows an outward expand pill (an 'open' or 'hop' card). */
  frontier: boolean
  /** True when this card is already expanded open. */
  frontierExpanded: boolean
  /** Expanded, fetch completed, and NOTHING further exists — the walk
   *  genuinely ends here (a data-source claim, never a guess). */
  deadEnd: boolean
  degreeHint: { in: number; out: number } | null
  fetch: 'loading' | 'error' | null
  /** Text-filter miss — rendered dimmed, never removed. */
  dimmed: boolean
  /** Collapsed group only: members matching the text filter. */
  matchesInside: number
  /** Overflow card only: how many more cards the band holds. */
  overflowCount: number
  /** Up to 3 names of what this card stands for, shown while it is
   *  still closed so you can often skip opening it. Only ever from
   *  data already in hand — never a speculative fetch. */
  previewLabels: string[]
}

export interface FocusEdge {
  id: string
  /** Card ids; source is the upstream side — data always flows L→R. */
  source: string
  target: string
  count: number
  edgeTypeNorm: string
  aggregated: boolean
  /** Dashed focal→child containment tether (not a flow edge). */
  containment: boolean
  dimmed: boolean
}

export interface FocusGraphInput {
  focalId: string
  incomingRecords: NeighborRecord[]
  outgoingRecords: NeighborRecord[]
  /** Endpoint-indexed edge sets — hop expansion derives deeper bands
   *  from this in O(degree). */
  edgesByEndpoint: Map<string, LineageEdge[]>
  nodeMap: Map<string, LineageNode>
  containmentEdgeTypes: string[]
  /** Focal's containment children (already derived, order preserved). */
  containsChildren: string[]
  /** Honest total for the contains stack (childCount can exceed loaded). */
  containsTotal?: number
  /** The focal's own children are being fetched — say so rather than
   *  printing a count the user cannot open yet. */
  containsLoading?: boolean
  /** Children already loaded for any entity, keyed by urn. Lets the
   *  contains stack go deeper than the focal's own row: a column that
   *  holds fields opens in place, at any depth. */
  containsChildrenOf?: ReadonlyMap<string, string[]>
  /** Contains rows the user has opened, by urn. Depth is not encoded —
   *  it emerges from the walk, so any level composes with any other. */
  openContains?: ReadonlySet<string>
  /** Fetch state per urn for the contains stack, so a row that came back
   *  EMPTY and a row that FAILED are distinguishable from one that is
   *  still loading — all three used to render as an open chevron with
   *  nothing under it. */
  containsStatusOf?: ReadonlyMap<string, 'loading' | 'done' | 'error' | 'unsupported'>
  resolveParent: (id: string) => string | null
  /** isCoarser(partnerType, baseType) — coarser-grain rollup test. */
  isCoarser: (type: string | undefined, baseType: string) => boolean
  /** Can this entity type hold anything, per the ontology? Decides
   *  whether a card offers to open its contents.
   *
   *  Deliberately the ONTOLOGY and not `childCount`: that field is
   *  populated by a real count on some read paths and by an unreliable
   *  stored property on others, so gating on it hid the affordance
   *  exactly where it was needed. A type that can contain always
   *  offers; an open that finds nothing says so, which is a real
   *  answer rather than a missing button. */
  canContain: (type: string | undefined) => boolean
  /**
   * Fold a coarser partner into the finer one it is an ancestor of.
   *
   * `expandAggregated` reports one real connection at EVERY grain above
   * it, so a single column→column fact arrives four times: the column,
   * its table, its container, its platform. All four were drawn as
   * separate cards ("4 connections · 3 rolled-up"), which is the same
   * answer restated, not four answers. On, the finest card survives and
   * says which grains it also stands for. */
  foldCoarserRestatements?: boolean
  /** Frames the user has COLLAPSED, keyed `${dir}:${parentUrn}`.
   *
   *  Inverse of the old `expandedGroups`, and the inversion is the
   *  point: a column's provenance is the reason the Lens exists, so a
   *  table that has connected columns opens showing them. Closed-by-
   *  default made "where does this field come from" a thing you had to
   *  already suspect before you could ask it. */
  collapsedFrames: ReadonlySet<string>
  expandedFrontier: ReadonlySet<string>
  /** Containers the user has opened, keyed `${dir}:${urn}`. */
  openContainers: ReadonlySet<string>
  /** Server answers to those opens (useLensContainer), same keys. */
  containerResults?: Map<string, {
    nodes: LineageNode[]
    edges: LineageEdge[]
    passedThrough: LineageNode[]
    truncated: boolean
    empty: boolean
  }>
  containerStatus?: Map<string, 'loading' | 'done' | 'error' | 'unsupported'>
  /** Frames switched from "only what connects" to "everything inside",
   *  keyed like openContainers. */
  frameShowAll?: ReadonlySet<string>
  /** Every child of those containers (useLensContainer), same keys. The
   *  server cannot flag children by whether they reach the focal, so
   *  this answers membership and containerResults answers lineage. */
  frameAllResults?: Map<string, {
    children: LineageNode[]
    hasMore: boolean
    total: number | null
  }>
  frameAllStatus?: Map<string, 'loading' | 'done' | 'error' | 'unsupported'>
  /** Per-frame filter text, keyed like openContainers. */
  frameQueries?: ReadonlyMap<string, string>
  /** Extra pages unlocked inside a frame, keyed like openContainers. */
  framePages?: ReadonlyMap<string, number>
  /** Entity-type id → hierarchy level. A type absent here is UNKNOWN,
   *  and an unknown level means we cannot ask the server for the next
   *  grain down — so the card offers no open rather than guessing. */
  entityLevels?: Map<string, number>
  /** Extra pages unlocked per band key `${dir}:${band}`. */
  bandPages: ReadonlyMap<string, number>
  query: string
  hiddenTypes: ReadonlySet<string>
  degreeHints?: Map<string, { in: number; out: number }>
  fetchStatus?: Map<string, 'loading' | 'done' | 'error'>
}

export interface FocusGraph {
  cards: FocusCard[]
  edges: FocusEdge[]
  /** Records removed by the type chips (reported next to the chips). */
  hiddenByChips: number
  /** Per-direction split of the above. An empty band is only a claim
   *  about the DATA SOURCE when the user's own type chips did not empty
   *  it — otherwise "No upstream sources in the data source" reports the
   *  filter as a fact. */
  hiddenByChipsIn: number
  hiddenByChipsOut: number
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
  /** Records the AUTO grain fold removed as coarser restatements of a
   *  connection already on the board, and the entity types they came
   *  in as. Without this the header counted RECORDS ("9 connections")
   *  while the board drew the folded set (3 cards) and nothing on
   *  screen reconciled the two — the picture read as if six things had
   *  silently gone missing. */
  foldedAway: number
  foldedGrains: string[]
}

/** Display label for a node — the same fallback chain the list body
 *  uses, exported so both modes always agree. */
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

interface AggInfo {
  aggregated: boolean
}

/** One deduped neighbor of a band's reference node(s). */
interface BandEntry {
  nodeId: string
  node: LineageNode | undefined
  count: number
  edgeTypeNorm: string
  agg: AggInfo
  rollup: boolean
  /** Reference nodes this neighbor connects to (→ edges), with counts. */
  refs: Map<string, { count: number; edgeTypeNorm: string; aggregated: boolean }>
}

/** How many underlying connections a record stands for. The derivation
 *  already folded synthetic rollups into their concrete sibling and put
 *  the honest floor on `bundledCount` — re-deriving it from the edge
 *  here would lose the absorbed weight. */
const recordCount = (r: NeighborRecord): number => Math.max(r.bundledCount, 1)

export function buildFocusGraph(input: FocusGraphInput): FocusGraph {
  const {
    focalId, incomingRecords, outgoingRecords, edgesByEndpoint, nodeMap,
    containmentEdgeTypes, containsChildren, containsTotal, containsLoading, resolveParent,
    containsChildrenOf, openContains = EMPTY_SET, containsStatusOf,
    isCoarser, canContain, foldCoarserRestatements = false, collapsedFrames, expandedFrontier, openContainers,
    containerResults, containerStatus, frameShowAll, frameAllResults,
    frameAllStatus, frameQueries, framePages, entityLevels,
    bandPages, query, hiddenTypes, degreeHints, fetchStatus,
  } = input

  const q = query.trim().toLowerCase()
  const matches = (label: string) => q === '' || label.toLowerCase().includes(q)

  const cards: FocusCard[] = []
  const edges: FocusEdge[] = []
  const edgeById = new Map<string, FocusEdge>()
  const bandTotals = new Map<string, { shown: number; total: number; connections: number }>()
  let hiddenByChipsIn = 0
  let hiddenByChipsOut = 0
  let foldedAway = 0
  const foldedGrains = new Set<string>()

  /** The ONE way an edge reaches the output. Every id passes through
   *  `edgeById`, so a collision is impossible rather than merely
   *  unlikely — a duplicate id would be silently dropped downstream,
   *  because React Flow keys on it. */
  const addRawEdge = (e: FocusEdge) => {
    if (edgeById.has(e.id)) return
    edgeById.set(e.id, e)
    edges.push(e)
  }

  // Bundles duplicates (same source→target) into one edge, summed.
  // Data flows left → right: for an upstream neighbor the edge runs
  // neighbor → reference; downstream it runs reference → neighbor.
  const addFlowEdge = (
    dir: FocusDirection, refCardId: string, otherCardId: string,
    count: number, edgeTypeNorm: string, aggregated: boolean, dimmed: boolean,
  ) => {
    const source = dir === 'in' ? otherCardId : refCardId
    const target = dir === 'in' ? refCardId : otherCardId
    const id = `fe:${source}->${target}`
    const existing = edgeById.get(id)
    if (existing) {
      existing.count += count
      existing.aggregated = existing.aggregated || aggregated
      if (existing.edgeTypeNorm !== edgeTypeNorm) existing.edgeTypeNorm = ''
      existing.dimmed = existing.dimmed && dimmed
      return
    }
    addRawEdge({ id, source, target, count, edgeTypeNorm, aggregated, containment: false, dimmed })
  }

  /** Every placed entity: nodeId → card id. A node is never placed
   *  twice — a repeat sighting only adds an edge to the existing card
   *  (this is what makes cyclic lineage safe to expand). */
  const placed = new Map<string, string>()

  /**
   * The containment chain above an entity, root-first, as labels.
   *
   * `resolveParent` gives one level; a column's owner is only legible
   * with the chain, because sibling tables routinely share every
   * character but the last (`..._t1` / `..._t2`). Memoized because it is
   * called once per card and `resolveParent` is O(degree); guarded
   * against cyclic containment and capped so a pathological chain
   * cannot stall a build.
   */
  const ancestryCache = new Map<string, string[]>()
  const ancestryIdsOf = (id: string): string[] => {
    const hit = ancestryCache.get(id)
    if (hit) return hit
    const out: string[] = []
    const seen = new Set<string>([id])
    let p = resolveParent(id)
    while (p && !seen.has(p) && out.length < ANCESTRY_CAP) {
      seen.add(p)
      out.push(p)
      p = resolveParent(p)
    }
    out.reverse()
    ancestryCache.set(id, out)
    return out
  }
  const ancestryOf = (id: string): string[] =>
    ancestryIdsOf(id).map(a => labelOf(a, nodeMap.get(a)))

  /**
   * The ONE way a card reaches the output.
   *
   * "One entity, one card" used to be a convention that every call site
   * had to remember, enforced by a `placed` lookup near some pushes and
   * not others — and the group header, which skipped it entirely, drew
   * the same entity twice. Routing every push through here makes the
   * invariant structural instead: a second card for an entity already
   * on the board is refused, whatever new path finds it.
   *
   * Returns the id of the card representing that entity — the existing
   * one when a duplicate was refused — so callers can still wire edges
   * to it. Overflow cards (nodeId === null) stand for no entity and are
   * always appended.
   */
  const pushCard = (card: FocusCard): string => {
    if (card.nodeId === null) { cards.push(card); return card.id }
    const existing = placed.get(card.nodeId)
    if (existing) return existing
    placed.set(card.nodeId, card.id)
    cards.push(card)
    return card.id
  }
  /** The partner an open should ask about, named for the UI. Null when
   *  it is the focal — band 1 keeps the unqualified wording. */
  const partnerLabelOf = (refIds: string[]): string | null => {
    const first = refIds[0]
    if (!first || first === focalId) return null
    return labelOf(first, nodeMap.get(first))
  }

  const focalNode = nodeMap.get(focalId)
  const focalType = (focalNode?.data?.type as string) ?? 'entity'
  const focalLabel = labelOf(focalId, focalNode)

  const baseCard = (): Omit<FocusCard, 'id' | 'kind' | 'nodeId' | 'band' | 'label' | 'type'> => ({
    x: 0, y: 0, w: CARD_W, h: CARD_H,
    description: null,
    parentId: null, parentLabel: null,
    count: 1, edgeTypeNorm: '', sumCount: 0,
    rollup: false, unresolved: false,
    aggregated: false,
    frameId: null, depth: 0, ancestry: EMPTY_STRINGS, ancestryIds: EMPTY_STRINGS, alsoAtGrains: EMPTY_STRINGS, frameBreadcrumb: EMPTY_STRINGS, frameTruncated: false, frameEmpty: false,
    connected: true, frameShowingAll: false, frameConnectedCount: 0,
    frameLoaded: 0, frameTotal: -1, frameHasMore: false, frameLocal: false,
    frameSharedEdgeType: '', alreadyShown: false,
    framePage: 0, framePageSize: FRAME_ALL_CAP,
    partnerIds: EMPTY_STRINGS, partnerLabel: null,
    canOpenChildren: false, childrenOpen: false,
    expandKey: null, expanded: false,
    expandKind: null, frontier: false, frontierExpanded: false, deadEnd: false,
    degreeHint: null, fetch: null,
    dimmed: false, matchesInside: 0,
    overflowCount: 0, previewLabels: EMPTY_STRINGS,
  })

  // ── Focal card + contains stack (band 0) ───────────────────────────
  const focal: FocusCard = {
    ...baseCard(),
    id: 'f',
    kind: 'focal',
    nodeId: focalId,
    band: 0,
    h: FOCAL_H,
    label: focalLabel,
    description: (focalNode?.data?.description as string | undefined) ?? null,
    type: focalType,
    parentId: resolveParent(focalId),
    parentLabel: null,
    unresolved: !focalNode,
    fetch: fetchStatus?.get(focalId) === 'loading' ? 'loading'
      : fetchStatus?.get(focalId) === 'error' ? 'error' : null,
    dimmed: !matches(focalLabel),
  }
  focal.parentLabel = focal.parentId ? labelOf(focal.parentId, nodeMap.get(focal.parentId)) : null
  // The focal states the WHOLE chain: six levels is the stated case and
  // one parent label cannot express it. Levels above the grain are a
  // breadcrumb, never geometry.
  focal.ancestry = ancestryOf(focalId)
  focal.ancestryIds = ancestryIdsOf(focalId)
  focal.ancestry = ancestryOf(focalId)
  pushCard(focal)

  // The focal's fields are structure, not lineage — showing a dozen of
  // them by default buried the middle of the graph in dashed tethers.
  // Start as one summary card; opening it reveals them.
  const containsPages = bandPages.get('contains') ?? 0
  const containsCap = containsPages > 0 ? CONTAINS_CAP * containsPages : 0
  const containsShown = containsChildren.slice(0, containsCap)

  /**
   * The stack, walked. Depth is NOT state — it emerges from the walk,
   * so a column that holds fields opens in place exactly like the focal
   * does, at whatever level it sits. `openContains` is one flat set of
   * urns; every level composes with every other.
   */
  const emitContains = (ids: string[], depth: number, tetherTo: string) => {
    for (const cid of ids) {
      if (placed.has(cid)) continue
      const cNode = nodeMap.get(cid)
      const cLabel = labelOf(cid, cNode)
      const cType = (cNode?.data?.type as string) ?? 'entity'
      const kids = containsChildrenOf?.get(cid)
      const open = openContains.has(cid)
      const status = containsStatusOf?.get(cid)
      // The stack stops nesting at CONTAINS_MAX_DEPTH — a single column
      // hanging off the focal cannot grow forever. But the control must
      // not stop meaning something: at the limit it becomes "focus this",
      // which re-centers the lens so this entity's contents are the new
      // top level. Offering the chevron here fetched and rendered nothing.
      const canGoDeeper = canContain(cType)
      const atLimit = depth >= CONTAINS_MAX_DEPTH
      const card: FocusCard = {
        ...baseCard(),
        id: `c:${cid}`,
        kind: 'contains',
        nodeId: cid,
        band: 0,
        h: CONTAINS_H,
        depth,
        label: cLabel,
        type: cType,
        unresolved: !cNode,
        ancestry: ancestryOf(cid), ancestryIds: ancestryIdsOf(cid),
        // Offered from the ontology, like every other contents control.
        canOpenChildren: canGoDeeper && !atLimit,
        childrenOpen: open,
        expandKey: `kids:${cid}`,
        expandKind: canGoDeeper && atLimit ? 'focus' : null,
        fetch: status === 'loading' ? 'loading' : status === 'error' ? 'error' : null,
        dimmed: !matches(cLabel),
      }
      pushCard(card)
      // `ce:` not `fe:` — a containment tether and a LINEAGE edge between
      // the same pair are different facts and must both be drawable. They
      // shared an id space until now, so a contained child that also
      // carried downstream lineage produced two edges with one id, and
      // React Flow (which keys on id) silently dropped one of them.
      addRawEdge({
        id: `ce:${tetherTo}->${card.id}`,
        source: tetherTo,
        target: card.id,
        count: 1,
        edgeTypeNorm: 'contains',
        aggregated: false,
        containment: true,
        dimmed: card.dimmed,
      })
      if (!open || atLimit) continue
      // An opened row must always SAY something. Loading is the chevron's
      // own spinner; done-and-empty and failed each get a row, because
      // silence under an open chevron reads as a broken control.
      if (status === 'error' || (status === 'done' && (kids?.length ?? 0) === 0)) {
        pushCard({
          ...baseCard(),
          id: `note:c:${cid}`,
          kind: 'overflow',
          // NOT `nodeId` — that means "this card IS this entity" and
          // would be refused by the one-entity-one-card gate, silently
          // dropping the note. `parentId` is what it stands beneath.
          nodeId: null,
          parentId: cid,
          band: 0,
          h: OVERFLOW_H,
          depth: depth + 1,
          label: status === 'error'
            ? `Couldn't look inside ${cLabel} — retry`
            : `Nothing inside ${cLabel}`,
          type: 'entity',
          // NOT `expandKind: 'more'` with a `kids:` key — that routed to
          // the band pager, which reads nothing of the sort, so the
          // retry was itself a dead control.
          expandKind: status === 'error' ? 'retry' : null,
        })
        continue
      }
      if (!kids?.length) continue
      // A level shows CONTAINS_CAP rows. Beyond that the honest move is
      // not a "+N more" that pages this column deeper — it is to focus
      // the entity, where its children become the top level and get the
      // focal's own paging, Find and counts.
      emitContains(kids.slice(0, CONTAINS_CAP), depth + 1, card.id)
      if (kids.length > CONTAINS_CAP) {
        pushCard({
          ...baseCard(),
          id: `more:c:${cid}`,
          kind: 'overflow',
          nodeId: null,
          parentId: cid,
          band: 0,
          h: OVERFLOW_H,
          depth: depth + 1,
          label: `+${(kids.length - CONTAINS_CAP).toLocaleString()} more inside ${cLabel} — focus it`,
          type: 'entity',
          expandKind: 'focus',
          overflowCount: kids.length - CONTAINS_CAP,
        })
      }
    }
  }
  emitContains(containsShown, 0, 'f')
  const containsTotalAll = Math.max(containsChildren.length, containsTotal ?? 0)
  // While the fetch is in flight we know neither the children nor the
  // count — but the affordance must still be there, or the focal reads
  // as "contains nothing" for as long as the request takes. `childCount`
  // is absent on every lineage/trace read path, so that was the common
  // case, not the rare one.
  if (containsTotalAll > containsShown.length || (containsLoading && containsShown.length === 0)) {
    pushCard({
      ...baseCard(),
      id: 'more:contains',
      kind: 'overflow',
      nodeId: null,
      band: 0,
      h: OVERFLOW_H,
      label: containsLoading && containsShown.length === 0
        ? containsTotalAll > 0 ? `loading ${containsTotalAll.toLocaleString()} contained…` : 'loading contents…'
        : containsShown.length === 0
          ? `contains ${containsTotalAll.toLocaleString()}`
          : `+${(containsTotalAll - containsShown.length).toLocaleString()} more contained`,
      type: 'entity',
      expandKey: 'contains',
      expandKind: 'more',
      overflowCount: containsTotalAll - containsShown.length,
    })
  }

  // ── Per-direction band construction ────────────────────────────────
  const buildDirection = (dir: FocusDirection) => {
    const sign = dir === 'in' ? -1 : 1
    // Reference nodes whose neighbors feed the NEXT band out. Seeded
    // with the focal; deeper bands come from expanded frontier cards.
    let refs: Array<{ nodeId: string; type: string }> = [{ nodeId: focalId, type: focalType }]

    for (let band = 1; band <= MAX_BAND && refs.length > 0; band++) {
      // Collect this band's records from every reference node. Track
      // how much each expanded ref contributed — an expanded ref whose
      // COMPLETED fetch yields nothing is a true dead end, and the UI
      // must say so rather than let an expansion silently no-op.
      // (Counted before the chip filter: hidden ≠ nonexistent.)
      const refContrib = new Map<string, number>()
      const refFresh = new Map<string, number>()
      const entryMap = new Map<string, BandEntry>()
      for (const ref of refs) {
        const recs = ref.nodeId === focalId
          ? (dir === 'in' ? incomingRecords : outgoingRecords)
          : (() => {
              const derived = deriveNeighborRecords(
                ref.nodeId, edgesByEndpoint.get(ref.nodeId) ?? [], nodeMap, containmentEdgeTypes,
              )
              return dir === 'in' ? derived.incomingRecords : derived.outgoingRecords
            })()
        for (const r of recs) {
          // The band grows OUTWARD only — a neighbor already placed
          // anywhere (any band, either side, the focal itself) gets an
          // edge to its existing card instead of a duplicate.
          refContrib.set(ref.nodeId, (refContrib.get(ref.nodeId) ?? 0) + 1)
          // Separately: did it reach anything NOT already on the board?
          // An expansion whose neighbours are all placed adds edges and
          // no cards, and the only feedback was the pill changing glyph.
          if (!placed.has(r.neighborId)) refFresh.set(ref.nodeId, (refFresh.get(ref.nodeId) ?? 0) + 1)
          const t = (r.neighborNode?.data?.type as string) ?? UNRESOLVED_TYPE
          if (hiddenTypes.has(t)) { if (dir === 'in') hiddenByChipsIn++; else hiddenByChipsOut++; continue }
          // From the RECORD, not the edge: the derivation folds a
          // synthetic rollup into its concrete sibling, so the flag no
          // longer lives on the surviving edge's data.
          const isAgg = r.aggregated
          const n = recordCount(r)
          if (placed.has(r.neighborId)) {
            const existing = placed.get(r.neighborId)!
            const refCard = placed.get(ref.nodeId)
            if (refCard && existing !== refCard) {
              addFlowEdge(dir, refCard, existing, n, r.edgeTypeNorm, isAgg, false)
            }
            continue
          }
          let entry = entryMap.get(r.neighborId)
          if (!entry) {
            entry = {
              nodeId: r.neighborId,
              node: r.neighborNode,
              count: 0,
              edgeTypeNorm: r.edgeTypeNorm,
              agg: { aggregated: false },
              // An unresolved reference has the placeholder type, and
              // nothing is ever "coarser than 'not loaded'" — which
              // silently downgraded every rollup behind it from an
              // open into a hop. Fall back to the focal's grain: the
              // walk is anchored there, so it is the honest baseline.
              rollup: isCoarser(
                r.neighborNode?.data?.type as string | undefined,
                ref.type === UNRESOLVED_TYPE ? focalType : ref.type,
              ),
              refs: new Map(),
            }
            entryMap.set(r.neighborId, entry)
          }
          entry.count += n
          if (isAgg) entry.agg = { aggregated: true }
          const refStat = entry.refs.get(ref.nodeId)
          if (refStat) {
            refStat.count += n
            // Mixed relationship types bundle into one edge, so the
            // edge stops claiming a single type rather than reporting
            // whichever record happened to arrive first.
            if (refStat.edgeTypeNorm !== r.edgeTypeNorm) refStat.edgeTypeNorm = ''
            if (isAgg) refStat.aggregated = true
          } else {
            entry.refs.set(ref.nodeId, { count: n, edgeTypeNorm: r.edgeTypeNorm, aggregated: isAgg })
          }
        }
      }

      // Stamp "already on the board" onto an expansion that fetched
      // fine and reached only cards that were drawn already: it added
      // edges and nothing else, so without saying so the click changed
      // a glyph and the picture appeared frozen.
      for (const ref of refs) {
        if (ref.nodeId === focalId) continue
        if ((refContrib.get(ref.nodeId) ?? 0) === 0) continue
        if ((refFresh.get(ref.nodeId) ?? 0) > 0) continue
        if (fetchStatus?.get(ref.nodeId) !== 'done') continue
        const cardId = placed.get(ref.nodeId)
        const shownCard = cardId ? cards.find(c => c.id === cardId) : undefined
        if (shownCard) shownCard.alreadyShown = true
      }

      // Stamp dead ends onto the previous band's expanded cards: fetch
      // completed, zero records either direction of growth — the walk
      // ends here in the data source, and the pill will say so.
      for (const ref of refs) {
        if (ref.nodeId === focalId) continue
        if ((refContrib.get(ref.nodeId) ?? 0) > 0) continue
        if (fetchStatus?.get(ref.nodeId) !== 'done') continue
        const cardId = placed.get(ref.nodeId)
        const refCard = cardId ? cards.find(c => c.id === cardId) : undefined
        if (refCard) {
          refCard.deadEnd = true
          refCard.frontier = false
        }
      }

      // Bucket by immediate known parent: ≥2 members → a group card.
      // Fold coarser RESTATEMENTS of a connection into the finest one.
      // `expandAggregated` reports the same fact at every grain above it,
      // so one column→column connection arrives as the column, its table,
      // its container and its platform — four cards for one answer, which
      // is what "4 connections · 3 rolled-up" was counting. Keep the
      // finest and let it say which grains it also stands for.
      // Keyed by the surviving (finest) entry → the ancestors folded
      // into it. The ID travels with the type because WHERE the marker
      // belongs depends on it: a restatement of the whole group at its
      // own table's grain is a fact about the group, not about whichever
      // column the fold happened to reach first.
      const foldedInto = new Map<string, Array<{ id: string; type: string }>>()
      if (foldCoarserRestatements) {
        const present = new Map<string, BandEntry>()
        for (const e of entryMap.values()) present.set(e.nodeId, e)
        for (const e of [...entryMap.values()]) {
          // Every ancestor of this entry that is ALSO a partner in this
          // band is the same connection one grain coarser.
          // Nearest ancestor first, so the marker reads outward: this
          // column, also its table, its container, its platform.
          for (const anc of [...ancestryIdsOf(e.nodeId)].reverse()) {
            const coarser = present.get(anc)
            if (!coarser) continue
            entryMap.delete(anc)
            present.delete(anc)
            foldedAway += coarser.count
            const t = (coarser.node?.data?.type as string) ?? UNRESOLVED_TYPE
            foldedGrains.add(t)
            const list = foldedInto.get(e.nodeId) ?? []
            if (!list.some(f => f.id === anc)) list.push({ id: anc, type: t })
            foldedInto.set(e.nodeId, list)
          }
        }
      }
      const entries = [...entryMap.values()]
      const groups = new Map<string, BandEntry[]>()
      const standalone: BandEntry[] = []
      const rollups: BandEntry[] = []
      for (const e of entries) {
        if (e.rollup) { rollups.push(e); continue }
        const p = resolveParent(e.nodeId)
        // A parent that is itself a neighbour used to BAR its children
        // from grouping — otherwise the parent got two cards, one as a
        // rollup and one as a group header. That guard is gone because
        // the group header is now a frame, which IS the parent's card:
        // it holds the children and absorbs the parent's own entry
        // below, so the duplication it prevented cannot arise. What the
        // guard did produce was the ordinary shape of column lineage —
        // a table and eight of its columns all neighbours of the focal —
        // rendering as one table card plus eight LOOSE column cards,
        // each captioned with a truncated copy of the parent it should
        // have been drawn inside.
        if (p && p !== focalId && !placed.has(p) && !refs.some(r => r.nodeId === p)) {
          const g = groups.get(p)
          if (g) g.push(e)
          else groups.set(p, [e])
        } else {
          standalone.push(e)
        }
      }
      // One child is not a group: a lone column reads better as itself
      // (with its provenance ribbon) than as a frame wrapping one row.
      // A parent that is ALSO a neighbour is the exception — the frame
      // is where its own card goes, so it is worth building for one.
      for (const [p, members] of [...groups.entries()]) {
        if (members.length < 2 && !entryMap.has(p)) {
          standalone.push(...members)
          groups.delete(p)
        }
      }
      // TWO LEVELS OF GEOMETRY, never three. A parent that holds a frame
      // of its own is not also drawn as a row inside its own parent's
      // frame — that is the nesting the 6-level ontology would run away
      // with (46px of header and 20px of padding per level, before any
      // content). Levels above the frame are the breadcrumb ribbon;
      // levels below the rows are a count and a re-grain.
      for (const [p, members] of groups) {
        const promoted = members.filter(m => groups.has(m.nodeId))
        if (promoted.length === 0) continue
        groups.set(p, members.filter(m => !groups.has(m.nodeId)))
        standalone.push(...promoted)
      }
      for (const [p, members] of [...groups.entries()]) {
        if (members.length === 0) groups.delete(p)
      }
      // The parent's own entry becomes the frame rather than a sibling
      // of it, so its connection is drawn once, on the frame.
      const framedParents = new Map<string, BandEntry>()
      for (const p of groups.keys()) {
        const own = entryMap.get(p)
        if (own) framedParents.set(p, own)
      }
      for (const i of [...standalone.keys()].reverse()) {
        if (framedParents.has(standalone[i].nodeId)) standalone.splice(i, 1)
      }

      // Deterministic order: groups by member count desc, then entities
      // by connection count desc, label asc; rollups always last.
      const groupList = [...groups.entries()].sort((a, b) =>
        b[1].length - a[1].length
        || labelOf(a[0], nodeMap.get(a[0])).localeCompare(labelOf(b[0], nodeMap.get(b[0])))
        || a[0].localeCompare(b[0]))
      const byCountLabel = (a: BandEntry, b: BandEntry) =>
        b.count - a.count
        || labelOf(a.nodeId, a.node).localeCompare(labelOf(b.nodeId, b.node))
        || a.nodeId.localeCompare(b.nodeId)
      standalone.sort(byCountLabel)
      rollups.sort(byCountLabel)

      type BandItem =
        | { kind: 'frame'; parentId: string; members: BandEntry[] }
        | { kind: 'entity'; entry: BandEntry }
      const items: BandItem[] = [
        ...groupList.map(([parentId, members]) => ({ kind: 'frame' as const, parentId, members })),
        ...standalone.map(entry => ({ kind: 'entity' as const, entry })),
        ...rollups.map(entry => ({ kind: 'entity' as const, entry })),
      ]

      // Band cap + paging → overflow card, totals stay honest.
      // `band:` prefix, not `${dir}:${band}` — a bare `in:1` collides
      // with the `${dir}:${urn}` space that frames and groups use, and
      // the caller routes "show more" by key prefix.
      const bandKey = `band:${dir}:${band}`
      const cap = GRAPH_BAND_CAP * (1 + (bandPages.get(bandKey) ?? 0))
      const shown = items.slice(0, cap)
      bandTotals.set(bandKey, {
        shown: Math.min(items.length, cap),
        total: items.length,
        connections: items.reduce((acc, it) => acc + (it.kind === 'frame'
          ? it.members.reduce((n, m) => n + m.count, 0)
          : it.entry.count), 0),
      })

      const nextRefs: Array<{ nodeId: string; type: string }> = []
      const isOutermost = band === MAX_BAND

      const placeEntity = (entry: BandEntry) => {
        const label = labelOf(entry.nodeId, entry.node)
        const type = (entry.node?.data?.type as string) ?? UNRESOLVED_TYPE
        const parentId = resolveParent(entry.nodeId)
        const frontierKey = `${dir}:${entry.nodeId}`
        const frontierExpanded = expandedFrontier.has(frontierKey)
        // ONE expand gesture per card. A COARSER partner (a container, a
        // platform) opens into the entities inside it that carry lineage
        // to the focal — the question such a card otherwise withholds.
        // This deliberately does NOT key off `isAggregated`: that flag
        // is absent from projected canvas edges, which is why coarse
        // cards used to fall through to a hop and fetch the container's
        // whole neighbourhood instead. An unknown type level means we
        // cannot ask the server for the next grain, so we offer nothing
        // rather than guess. Everything else expands to its own next hop.
        // TWO questions, TWO controls. "What is inside this" was only
        // ever offered to coarser-grain partners (`entry.rollup`), so an
        // ordinary same-grain neighbour — a dataset upstream of your
        // dataset — could never show its columns: the one pill it had
        // did a lineage hop instead. They are independent now, and a
        // card may offer both.
        // `entry.rollup` is itself a canContain-closure test against the
        // ref's grain, so a coarser partner can contain by construction
        // even when the caller's ontology predicate has no entry for it.
        const canOpenKids = (canContain(type) || entry.rollup) && entityLevels?.get(type) !== undefined
        const canHop = !isOutermost && (degreeHints?.get(entry.nodeId)?.[dir] ?? -1) !== 0
        const expandKind: FocusExpandKind = canHop ? 'hop' : null
        const openKey = `${dir}:${entry.nodeId}`
        const card: FocusCard = {
          ...baseCard(),
          id: `n:${entry.nodeId}`,
          kind: 'entity',
          nodeId: entry.nodeId,
          band: sign * band,
          label,
          description: (entry.node?.data?.description as string | undefined) ?? null,
          type,
          parentId,
          parentLabel: parentId ? labelOf(parentId, nodeMap.get(parentId)) : null,
          ancestry: ancestryOf(entry.nodeId), ancestryIds: ancestryIdsOf(entry.nodeId),
          alsoAtGrains: (foldedInto.get(entry.nodeId) ?? []).map(f => f.type),
          count: entry.count,
          edgeTypeNorm: entry.edgeTypeNorm,
          rollup: entry.rollup,
          unresolved: !entry.node,
          partnerIds: [...entry.refs.keys()],
          partnerLabel: partnerLabelOf([...entry.refs.keys()]),
          aggregated: entry.agg.aggregated,
          expandKey: frontierKey,
          expandKind,
          canOpenChildren: canOpenKids,
          childrenOpen: false,
          previewLabels: canOpenKids
            ? (containerResults?.get(openKey)?.nodes ?? []).slice(0, 3).map(n => labelOf(n.id, n))
            : EMPTY_STRINGS,
          frontier: expandKind === 'hop',
          frontierExpanded,
          degreeHint: degreeHints?.get(entry.nodeId) ?? null,
          fetch: fetchStatus?.get(entry.nodeId) === 'loading' ? 'loading'
            : fetchStatus?.get(entry.nodeId) === 'error' ? 'error' : null,
          dimmed: !matches(label),
        }
        pushCard(card)
        for (const [refId, stat] of entry.refs) {
          const refCard = placed.get(refId)
          if (refCard) addFlowEdge(dir, refCard, card.id, stat.count, stat.edgeTypeNorm, stat.aggregated, card.dimmed)
        }
        if (frontierExpanded && !isOutermost) nextRefs.push({ nodeId: entry.nodeId, type })

        return card
      }

      /**
       * An OPENED container: a frame standing for the container, holding
       * what's inside it. Children go through the same card shape as any
       * neighbour — they get their own expand affordance, counts, edges
       * and hover actions — so exploration continues through them
       * instead of dead-ending, which is what the old terminal
       * constituent cards did.
       *
       * Two modes. By default the frame holds only the entities that
       * carry lineage to the focal — the answer you opened it for. In
       * "show all" it holds every child in the server's own order, with
       * the connected ones marked in place and the rest present but
       * carrying no counts and no edges. Nothing is ever invented: a
       * child without lineage is drawn as having none.
       */
      /** What an open needs to know about its subject. A band entry
       *  satisfies it; a frame child opened one level deeper is
       *  synthesised, which is what lets frames nest. */
      type OpenSubject = Pick<BandEntry, 'nodeId' | 'node' | 'rollup' | 'refs'>
      const placeOpenContainer = (entry: OpenSubject, openKey: string, hostFrameId: string | null = null) => {
        const label = labelOf(entry.nodeId, entry.node)
        const type = (entry.node?.data?.type as string) ?? UNRESOLVED_TYPE
        const res = containerResults?.get(openKey)
        const status = containerStatus?.get(openKey)
        const frameId = `fr:${dir}:${entry.nodeId}`
        const showAll = frameShowAll?.has(openKey) ?? false
        const all = frameAllResults?.get(openKey)

        // Only entities we haven't already placed elsewhere on the board.
        // With frames claiming first (see the dispatch below) this now
        // strips only cross-band repeats, which are genuinely elsewhere.
        const connectedTotal = (res?.nodes ?? []).length
        const inside = (res?.nodes ?? []).filter(n => !placed.has(n.id))
        const connectedIds = new Set(inside.map(n => n.id))
        // In "all" mode the roster is the server's child order. A
        // connected entity missing from it is still shown (appended):
        // the pair-filtered open can resolve a grain deeper than direct
        // children, and dropping a real connection would be a lie.
        const roster = showAll
          ? (() => {
              const seen = new Set<string>()
              const list: LineageNode[] = []
              for (const c of all?.children ?? []) {
                if (placed.has(c.id) || seen.has(c.id)) continue
                seen.add(c.id)
                list.push(c)
              }
              for (const c of inside) {
                if (seen.has(c.id)) continue
                seen.add(c.id)
                list.push(c)
              }
              return list
            })()
          : inside
        const fq = (frameQueries?.get(openKey) ?? '').trim().toLowerCase()
        // ONE page on screen at a time, at a fixed size. The page index
        // is clamped to what has loaded, so paging past the fetched set
        // holds the last real page (and shows the frame's loading state)
        // instead of rendering an empty window.
        const pageSize = showAll ? FRAME_ALL_CAP : FRAME_CHILD_CAP
        const lastLoadedPage = Math.max(0, Math.ceil(roster.length / pageSize) - 1)
        const framePage = Math.min(Math.max(0, framePages?.get(openKey) ?? 0), lastLoadedPage)
        const shownInside = roster.slice(framePage * pageSize, framePage * pageSize + pageSize)

        // The container we actually opened may be deeper than the card
        // clicked, so its child count lives on the last skipped level.
        const anchorNode = res?.passedThrough?.[res.passedThrough.length - 1] ?? entry.node
        const anchorChildCount = anchorNode?.data?.childCount as number | undefined
        const allStatusHere = frameAllStatus?.get(openKey)

        const frame: FocusCard = {
          ...baseCard(),
          id: frameId,
          kind: 'frame',
          nodeId: entry.nodeId,
          band: sign * band,
          frameId: hostFrameId,
          label,
          description: (entry.node?.data?.description as string | undefined) ?? null,
          type,
          // What the SERVER said connects, not what survived deduping —
          // the frame used to under-report and hide the difference.
          count: connectedTotal,
          rollup: entry.rollup,
          unresolved: !entry.node,
          partnerIds: [...entry.refs.keys()],
          partnerLabel: partnerLabelOf([...entry.refs.keys()]),
          ancestry: ancestryOf(entry.nodeId), ancestryIds: ancestryIdsOf(entry.nodeId),
          expandKey: openKey,
          expandKind: 'open',
          canOpenChildren: true,
          childrenOpen: true,
          expanded: true,
          // Opening a card's CONTENTS must not cost it its lineage hop:
          // the two questions are independent, and a frame that swallowed
          // the ⊕ ended the walk at whatever you happened to look inside.
          // `openKey` and the frontier key are the same string, kept in
          // different sets — so the pill reads the right state.
          frontier: !isOutermost && (degreeHints?.get(entry.nodeId)?.[dir] ?? -1) !== 0,
          frontierExpanded: expandedFrontier.has(openKey),
          frameBreadcrumb: (res?.passedThrough ?? []).map(n => labelOf(n.id, n)),
          frameTruncated: res?.truncated ?? false,
          frameEmpty: res?.empty ?? false,
          frameShowingAll: showAll,
          frameConnectedCount: connectedTotal,
          frameLoaded: roster.length,
          // Known only once the last page lands, or from the container's
          // own childCount. Otherwise -1 — the view shows a floor.
          frameTotal: all?.total ?? (anchorChildCount && anchorChildCount > 0 ? anchorChildCount : -1),
          frameHasMore: all?.hasMore ?? false,
          framePage,
          framePageSize: pageSize,
          fetch: status === 'loading' || (showAll && allStatusHere === 'loading') ? 'loading'
            : status === 'error' || (showAll && allStatusHere === 'error') ? 'error' : null,
          dimmed: !matches(label),
        }
        // If this entity is already on the board (an earlier band drew
        // it), `pushCard` refuses the frame and returns the existing id.
        // Placing children under a frame that does not exist left them
        // with a dangling `frameId`: skipped by BOTH layout passes, so
        // they kept `x:0, y:0` and rendered stacked on top of the focal.
        if (pushCard(frame) !== frameId) return

        // Connection counts come from the server's pair-filtered edges.
        const countFor = (id: string) => {
          let n = 0
          for (const e of res?.edges ?? []) if (e.source === id || e.target === id) n++
          return Math.max(n, 1)
        }
        const edgeTypeFor = (id: string) => {
          for (const e of res?.edges ?? []) {
            if (e.source === id || e.target === id) return ((e.data?.edgeType as string) ?? '').toUpperCase()
          }
          return ''
        }
        // Over the CONNECTED roster, not the page on screen: the frame's
        // claim about its rows must not change as you page through them.
        // Unconnected children carry no type and so cannot dissent.
        const connectedTypes = inside.map(n => edgeTypeFor(n.id))
        const sharedEdgeType = connectedTypes.length > 0
          && connectedTypes.every(t => t === connectedTypes[0])
          ? connectedTypes[0]
          : ''
        frame.frameSharedEdgeType = sharedEdgeType

        for (const child of shownInside) {
          const cLabel = labelOf(child.id, child)
          const cType = (child.data?.type as string) ?? UNRESOLVED_TYPE
          const connected = connectedIds.has(child.id)
          const childOpenKey = `${dir}:${child.id}`
          // A child with no lineage to the focal has nothing to expand
          // TOWARDS it — offering a pill there would promise an answer
          // that is empty by construction.
          // A child that can itself hold things offers the same
          // chevron — that is what makes the drill go arbitrarily deep
          // (dataset → columns → nested fields) without leaving the
          // lens. Its lineage hop stays gated on actually having
          // lineage; its CONTENTS do not depend on that.
          const childCanOpenKids = canContain(cType) && entityLevels?.get(cType) !== undefined
          // Opened → the child becomes a frame of its own, drawn inside
          // this one. Frames nest to whatever depth the ontology allows,
          // which is what makes the drill go table → column → field
          // without ever re-centering the lens.
          if (childCanOpenKids && openContainers.has(childOpenKey) && !placed.has(child.id)) {
            placeOpenContainer(
              { nodeId: child.id, node: child, rollup: false, refs: entry.refs },
              childOpenKey,
              frameId,
            )
            continue
          }
          const childCanHop = connected && !isOutermost && (degreeHints?.get(child.id)?.[dir] ?? -1) !== 0
          const childKind: FocusExpandKind = childCanHop ? 'hop' : null
          const childFrontierKey = `${dir}:${child.id}`
          const childExpanded = expandedFrontier.has(childFrontierKey)
          const cCard: FocusCard = {
            ...baseCard(),
            id: `n:${child.id}`,
            kind: 'entity',
            nodeId: child.id,
            band: sign * band,
            h: connected
              ? rowHeight(sharedEdgeType, edgeTypeFor(child.id), EMPTY_STRINGS)
              : CHILD_ROW_H,
            frameSharedEdgeType: sharedEdgeType,
            label: cLabel,
            description: (child.data?.description as string | undefined) ?? null,
            type: cType,
            parentId: entry.nodeId,
            parentLabel: label,
            ancestry: ancestryOf(child.id), ancestryIds: ancestryIdsOf(child.id),
            partnerIds: [...entry.refs.keys()],
            partnerLabel: partnerLabelOf([...entry.refs.keys()]),
            connected,
            count: connected ? countFor(child.id) : 0,
            edgeTypeNorm: connected ? edgeTypeFor(child.id) : '',
            frameId,
            expandKey: childFrontierKey,
            expandKind: childKind,
            canOpenChildren: childCanOpenKids,
            childrenOpen: openContainers.has(childOpenKey),
            frontier: childKind !== null,
            frontierExpanded: childExpanded,
            degreeHint: connected ? (degreeHints?.get(child.id) ?? null) : null,
            fetch: fetchStatus?.get(child.id) === 'loading' ? 'loading'
              : fetchStatus?.get(child.id) === 'error' ? 'error' : null,
            // The frame's own filter dims, exactly like the global one.
            dimmed: !matches(cLabel) || (fq !== '' && !cLabel.toLowerCase().includes(fq)),
          }
          pushCard(cCard)
          // Only a child that actually carries lineage gets an edge, and
          // it carries ITS OWN count. `stat.count` is the CONTAINER's
          // bundled total, so every column inside a table reading ×57
          // used to draw a ×57 wire while its own badge said ×1 — one
          // edge asserting two different grains of truth, and a reader
          // counting wires concluding 12 × 57.
          if (connected) {
            for (const [refId] of entry.refs) {
              const refCard = placed.get(refId)
              if (refCard) addFlowEdge(dir, refCard, cCard.id, cCard.count, cCard.edgeTypeNorm, false, cCard.dimmed)
            }
          }
          if (connected && childExpanded && !isOutermost) nextRefs.push({ nodeId: child.id, type: cType })
        }

        // No "+N more inside" card: it raised the cap, so five clicks on
        // a 500-column table left a ~2,000px frame and 100 live cards.
        // The frame's own footer pager moves a fixed window instead.

        // With nothing rendered inside (loading, empty, error) the frame
        // would float unconnected — keep its own edge so the picture
        // still reads.
        if (shownInside.length === 0) {
          for (const [refId, stat] of entry.refs) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, frameId, stat.count, stat.edgeTypeNorm, stat.aggregated, frame.dimmed)
          }
        }
        // Same rule as a plain card: an expanded frontier feeds the next
        // band. Opened frames used to be terminal, so the walk stopped
        // dead at anything you had looked inside.
        if (frame.frontierExpanded && !isOutermost) nextRefs.push({ nodeId: entry.nodeId, type })
      }

      /**
       * A frame built from what is ALREADY IN HAND — the band's own
       * entries, bucketed by parent — rather than from a server open.
       *
       * This is what a "group card" used to be, and the difference is
       * the whole of Phase 1. A group card was a single card captioned
       * with the parent's name that you had to know to click; its
       * members then spilled out beside it as full-size sibling cards,
       * indented, so a column and its table were peers in the same
       * band. Provenance was an 80px caption, which is why
       * `int_clean_orders_t1` and `int_clean_orders_t2` both read
       * `int_clean_order…` and nothing on screen could tell you which
       * table a field came from.
       *
       * A frame says it structurally: the rows are INSIDE the named
       * table. It also inherits, for free, everything the opened-
       * container frame already had — breadcrumb, fixed-window pager,
       * find, per-row counts and per-row edges — in place of the
       * group's unbounded `+N more` and one bundled type-erased wire.
       *
       * `ownEntry` is the parent's own band entry when the parent is a
       * neighbour in its own right. Its connection is drawn on the
       * frame, so the parent gets one card, not one beside its own
       * children.
       */
      const placeLocalFrame = (parentId: string, members: BandEntry[], ownEntry?: BandEntry) => {
        const key = `${dir}:${parentId}`
        const frameId = `fr:${dir}:${parentId}`
        const pNode = nodeMap.get(parentId)
        const pLabel = labelOf(parentId, pNode)
        const collapsed = collapsedFrames.has(key)
        const fq = (frameQueries?.get(key) ?? '').trim().toLowerCase()
        const pageSize = FRAME_CHILD_CAP
        const lastPage = Math.max(0, Math.ceil(members.length / pageSize) - 1)
        const framePage = Math.min(Math.max(0, framePages?.get(key) ?? 0), lastPage)
        const rows = collapsed
          ? []
          : members.slice(framePage * pageSize, framePage * pageSize + pageSize)
        const memberMatches = members.reduce(
          (acc, m) => acc + (matches(labelOf(m.nodeId, m.node)) ? 1 : 0), 0)
        // One relationship type across every row → the frame says it
        // once and the rows are sized to their names alone.
        const sharedEdgeType = members.every(m => m.edgeTypeNorm === members[0].edgeTypeNorm)
          ? members[0].edgeTypeNorm
          : ''
        // A coarser restatement of a connection is a fact about whatever
        // level it arrived at. When that level is this frame's own
        // parent or above, it describes the GROUP — the fold recorded it
        // against whichever member it reached first, which put a "+1
        // coarser grain" chip on one arbitrary column inside the very
        // table it was talking about. Hoist those to the frame; leave a
        // member's own deeper restatements on the member.
        const atOrAboveFrame = new Set([parentId, ...ancestryIdsOf(parentId)])
        const frameGrains: string[] = []
        const rowGrains = new Map<string, string[]>()
        for (const m of members) {
          const own: string[] = []
          for (const f of foldedInto.get(m.nodeId) ?? []) {
            if (atOrAboveFrame.has(f.id)) {
              if (!frameGrains.includes(f.type)) frameGrains.push(f.type)
            } else if (!own.includes(f.type)) own.push(f.type)
          }
          if (own.length > 0) rowGrains.set(m.nodeId, own)
        }
        const frame: FocusCard = {
          ...baseCard(),
          id: frameId,
          kind: 'frame',
          nodeId: parentId,
          band: sign * band,
          label: pLabel,
          description: (pNode?.data?.description as string | undefined) ?? null,
          type: (pNode?.data?.type as string) ?? UNRESOLVED_TYPE,
          ancestry: ancestryOf(parentId), ancestryIds: ancestryIdsOf(parentId),
          alsoAtGrains: frameGrains.length > 0
            ? frameGrains
            : (foldedInto.get(parentId) ?? []).map(f => f.type),
          count: members.length,
          sumCount: members.reduce((acc, m) => acc + m.count, 0),
          rollup: ownEntry?.rollup ?? false,
          unresolved: !pNode,
          partnerIds: [...new Set(members.flatMap(m => [...m.refs.keys()]))],
          partnerLabel: partnerLabelOf([...new Set(members.flatMap(m => [...m.refs.keys()]))]),
          previewLabels: collapsed ? members.slice(0, 3).map(m => labelOf(m.nodeId, m.node)) : EMPTY_STRINGS,
          expandKey: key,
          expandKind: 'open',
          canOpenChildren: true,
          childrenOpen: !collapsed,
          expanded: !collapsed,
          // A local frame's roster is complete by construction — these
          // are the band's own records, not a page of a server answer.
          frameLoaded: members.length,
          frameTotal: members.length,
          frameConnectedCount: members.length,
          frameHasMore: false,
          frameShowingAll: false,
          frameLocal: true,
          frameSharedEdgeType: sharedEdgeType,
          framePage,
          framePageSize: pageSize,
          // The parent's OWN hop, when it has one. Independent of the
          // rows, exactly as on an opened frame.
          frontier: !isOutermost && (degreeHints?.get(parentId)?.[dir] ?? -1) !== 0,
          frontierExpanded: expandedFrontier.has(key),
          degreeHint: degreeHints?.get(parentId) ?? null,
          dimmed: q !== '' && memberMatches === 0 && !matches(pLabel),
          matchesInside: collapsed ? memberMatches : 0,
        }
        if (pushCard(frame) !== frameId) return

        for (const m of rows) {
          const mLabel = labelOf(m.nodeId, m.node)
          const mType = (m.node?.data?.type as string) ?? UNRESOLVED_TYPE
          const mGrains = rowGrains.get(m.nodeId) ?? EMPTY_STRINGS
          const mCard: FocusCard = {
            ...baseCard(),
            id: `n:${m.nodeId}`,
            kind: 'entity',
            nodeId: m.nodeId,
            band: sign * band,
            h: rowHeight(sharedEdgeType, m.edgeTypeNorm, mGrains),
            frameSharedEdgeType: sharedEdgeType,
            label: mLabel,
            description: (m.node?.data?.description as string | undefined) ?? null,
            type: mType,
            parentId,
            parentLabel: pLabel,
            ancestry: ancestryOf(m.nodeId), ancestryIds: ancestryIdsOf(m.nodeId),
            alsoAtGrains: mGrains,
            count: m.count,
            edgeTypeNorm: m.edgeTypeNorm,
            unresolved: !m.node,
            aggregated: m.agg.aggregated,
            partnerIds: [...m.refs.keys()],
            partnerLabel: partnerLabelOf([...m.refs.keys()]),
            connected: true,
            frameId,
            // A row is the second and last level of geometry. What is
            // inside IT is reached by re-centering — the chevron is a
            // door, not another box drawn inside this one.
            expandKey: `${dir}:${m.nodeId}`,
            expandKind: (!isOutermost && (degreeHints?.get(m.nodeId)?.[dir] ?? -1) !== 0) ? 'hop' : null,
            canOpenChildren: canContain(mType) && entityLevels?.get(mType) !== undefined,
            childrenOpen: false,
            frontier: !isOutermost && (degreeHints?.get(m.nodeId)?.[dir] ?? -1) !== 0,
            frontierExpanded: expandedFrontier.has(`${dir}:${m.nodeId}`),
            degreeHint: degreeHints?.get(m.nodeId) ?? null,
            fetch: fetchStatus?.get(m.nodeId) === 'loading' ? 'loading'
              : fetchStatus?.get(m.nodeId) === 'error' ? 'error' : null,
            dimmed: !matches(mLabel) || (fq !== '' && !mLabel.toLowerCase().includes(fq)),
          }
          if (pushCard(mCard) !== mCard.id) continue
          for (const [refId, stat] of m.refs) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, mCard.id, stat.count, stat.edgeTypeNorm, stat.aggregated, mCard.dimmed)
          }
          if (mCard.frontierExpanded && !isOutermost) nextRefs.push({ nodeId: m.nodeId, type: mType })
        }

        // Collapsed, or paged past — the frame carries the connection
        // itself so the picture still reads, bundled and honest about
        // being a bundle. Rows on screen carry their own instead, so a
        // reader counting wires never double-counts.
        if (rows.length === 0) {
          const refSums = new Map<string, number>()
          for (const m of members) {
            for (const [refId, stat] of m.refs) refSums.set(refId, (refSums.get(refId) ?? 0) + stat.count)
          }
          for (const [refId, count] of refSums) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, frameId, count, '', false, frame.dimmed)
          }
        }
        // The parent's own connection, when it has one of its own.
        if (ownEntry) {
          for (const [refId, stat] of ownEntry.refs) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, frameId, stat.count, stat.edgeTypeNorm, stat.aggregated, frame.dimmed)
          }
        }
        if (frame.frontierExpanded && !isOutermost) {
          nextRefs.push({ nodeId: parentId, type: frame.type })
        }
      }

      // OPENED containers claim their contents before anything else in
      // the band draws a plain card. `shown` is ordered [groups,
      // standalone, rollups] and a container is always a rollup, so its
      // children — which are often direct neighbours in their own right —
      // were placed first and then filtered OUT of the frame by the
      // one-entity-one-card rule. The user opened a container and got an
      // empty dashed box captioned "0 connected", right after the closed
      // card had previewed those very children. An explicit open beats
      // the default layout.
      for (const item of shown) {
        if (item.kind !== 'entity') continue
        const openKey = `${dir}:${item.entry.nodeId}`
        if (openContainers.has(openKey)) placeOpenContainer(item.entry, openKey)
      }
      for (const item of shown) {
        if (item.kind === 'entity') {
          const openKey = `${dir}:${item.entry.nodeId}`
          if (!openContainers.has(openKey)) placeEntity(item.entry)
          continue
        }
        placeLocalFrame(item.parentId, item.members, framedParents.get(item.parentId))
      }

      if (items.length > cap) {
        pushCard({
          ...baseCard(),
          id: `more:${dir}:${band}`,
          kind: 'overflow',
          nodeId: null,
          band: sign * band,
          h: OVERFLOW_H,
          label: `+${(items.length - cap).toLocaleString()} more`,
          type: 'entity',
          expandKey: bandKey,
          expandKind: 'more',
          overflowCount: items.length - cap,
        })
      }

      refs = nextRefs
    }
  }

  buildDirection('in')
  buildDirection('out')

  layoutBands(cards)

  return {
    cards, edges,
    hiddenByChips: hiddenByChipsIn + hiddenByChipsOut, hiddenByChipsIn, hiddenByChipsOut,
    bandTotals,
    foldedAway, foldedGrains: [...foldedGrains].sort(),
  }
}

/**
 * Deterministic hop-band layout, baked into the cards in place:
 * x from the band index; y by stacking each band's cards (in insertion
 * order — the builder already sorted them) centered on the focal's
 * midline (y = 0). The focal band centers the FOCAL card itself on the
 * midline and hangs the contains stack below it, indented by
 * NEST_INDENT per level.
 *
 * A container FRAME is one stacking unit: its own height covers its
 * children, so the children are pulled out of the band's stacking pass
 * and positioned inside the frame afterwards. That keeps the band maths
 * (and its determinism) exactly as it was.
 */
function layoutBands(cards: FocusCard[]) {
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
      // Focal first (builder inserts it first), contains stack below.
      let y = -FOCAL_H / 2
      for (const c of list) {
        c.x = c.kind === 'focal' ? x : x + NEST_INDENT * (c.depth + 1)
        c.y = y
        y += c.h + (c.kind === 'focal' ? CONTAINS_STACK_GAP : CARD_GAP)
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

