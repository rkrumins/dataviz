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
import { gutterWidth } from './frame-flow'

/** Ontology wording for edge types, keyed by UPPERCASE id: the
 *  schema's display name + description when defined. */
export type EdgeTypeInfoMap = Map<string, { label: string; description?: string }>

/** Human wording for a normalized edge type — the ontology's display
 *  name when defined, a readable fallback otherwise ("FLOWS_TO" →
 *  "Flows to"). Raw ids are engineer-speak; every lens surface uses this
 *  so the wording never drifts. */
export const edgeLabelFor = (norm: string, info?: EdgeTypeInfoMap): string =>
  norm ? (info?.get(norm)?.label ?? relationshipLabel(norm)) : 'relationship'

/**
 * One half of the focal's ORIENTATION SENTENCE — "Fed by 3 sources
 * across 2 systems" — plain language, an honest floor (+), and "across
 * N systems" only where it says something a raw count does not (one
 * system alone is not worth naming). Shared by both lens bodies (the
 * graph focal and the list-mode focal) so the wording — and its fixes —
 * can never drift between them; it used to be two independent copies,
 * which is exactly how the bug below shipped in both at once.
 *
 * `count === 0` is NOT always "nothing exists" (`zero`): `floor` means
 * the data source has told this walk there IS more on this side, just
 * nothing has been fetched yet. Conflating the two rendered a false
 * "No upstream sources" beside a "Load upstream" button offering to
 * fetch exactly what that sentence just denied existed — the R1b defect
 * (spotlight chip) reached through a different door: the orientation
 * sentence never routed through the chip's own honest-wording function
 * at all. Fixed here, once, for both consumers.
 */
export function orientationHalf(
  verb: string, noun: string, dirWord: string, count: number, floor: boolean, systems: number, zero: string,
): string {
  if (count === 0) {
    return floor ? `nothing loaded ${dirWord} yet — the data source may have more` : zero
  }
  const sys = systems > 1 ? ` across ${systems} systems` : ''
  return `${verb} ${count.toLocaleString()}${floor ? '+' : ''} ${noun}${count === 1 ? '' : 's'}${sys}`
}

/** How far up the containment chain a card's provenance ribbon walks. */
export const ANCESTRY_CAP = 6

/** Rows a frame shows at once — the SCROLL WINDOW, not a page.
 *
 *  Sized so the frame stays a CARD, not a column. At 12/20 one screenful
 *  of a wide table came out ~1,030px tall — the viewport's fitView then
 *  zoomed to ~0.4 and every label on the board became unreadable. The
 *  fixed window is what keeps a 500-column table the same size as a
 *  5-column one; what MOVES it is a scroll rather than a page click. */
export const FRAME_WINDOW = 8
/** Same, but in "everything inside" mode — rows are shorter there, so a
 *  couple more fit in the same height. */
export const FRAME_WINDOW_ALL = 10

export const FRAME_HEADER_H = 46
export const FRAME_PAD = 10
/** The strip along the bottom of a SCROLLABLE list: where it says which
 *  rows are on screen and offers the click that moves the window.
 *
 *  Reserved in the GEOMETRY rather than floated over the last row,
 *  because a control drawn on top of a row is a control the reader has to
 *  discover by covering something up. Reported: a frame showing 8 of 14
 *  rows announced it with a hairline scrollbar and 9px of grey text, and
 *  the reader found the scrolling by accident. */
export const FRAME_FOOTER_H = 24

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
/** The focal node's HEADER height — and the whole of it when the focus
 *  holds nothing.
 *
 *  Sized to what it SAYS: the type and the controls every row-holding
 *  node carries, a name, the breadcrumb of where it lives, the "connect
 *  at a coarser grain" whisper when there is one, and the Reach line. It
 *  was 120 while it also carried a "N in / N out" row; that row was the
 *  walk's own loaded degree — a number that grew every time the reader
 *  clicked — and taking it out left a card two thirds full, which reads
 *  as something failing to render. */
export const FOCAL_H = 116
export const CARD_H = 64
/** A frame row with nothing to say beneath its name — its relationship
 *  is stated once on the frame, and it stands for no coarser grain.
 *  Sized to the name alone rather than to a subtitle that will not
 *  render. `rowHeight` below is the single place that decides. */
export const CHILD_ROW_H = 36
/** The quiet "everything else inside — N items" line that separates the
 *  rows on this lineage from the rows that merely live here. */
export const DIVIDER_ROW_H = 22

/** How tall a row inside a frame must be.
 *
 *  A row prints a SECOND LINE of its own only when it carries a
 *  relationship its siblings do not share — everything else a row says
 *  (its type where the frame mixes kinds, its ×N, what it holds, its
 *  description) fits the one cue line a 36px row already has. */
export function rowHeight(sharedEdgeType: string, ownEdgeType: string): number {
  return ownEdgeType !== '' && ownEdgeType !== sharedEdgeType ? CARD_H : CHILD_ROW_H
}
/** How long a drawn wire must be before it can carry a badge.
 *
 *  Two places decide with this and they have to agree: the LAYOUT picks
 *  which bundles get a badge from the geometry it just computed, and the
 *  VIEW re-checks it against the coordinates React Flow is actually
 *  drawing between. They diverge for a render whenever a node has not
 *  been measured yet — right after a reveal, most of all — and the
 *  layout's "yes" then paints a chip over a wire that has collapsed to a
 *  point. Reported live as ×15 ×14 ×13 ×12 ×11 stacked in mid-air beside
 *  a frame with no arrow under any of them. */
export const LABEL_MIN_RUN = 90

/**
 * Can the wire between these two points hold a badge?
 *
 * THE one predicate, called by both sides so they cannot drift: the
 * LAYOUT asks it of the geometry it has just computed (deciding
 * `FocusEdge.labelVisible`), and the VIEW asks it again of the
 * coordinates React Flow is actually drawing between. Those disagree for
 * a render whenever a node has not been measured yet — every reveal, and
 * every drag — and a badge decided by the first and drawn against the
 * second is a chip floating over a wire that has collapsed to a point.
 */
export function labelFitsRun(
  sourceX: number, sourceY: number, targetX: number, targetY: number,
): boolean {
  return Math.hypot(targetX - sourceX, targetY - sourceY) >= LABEL_MIN_RUN
}

export const BAND_GAP = 130
export const CARD_GAP = 10
/** Indent for cards hanging below the focal in its own band. */
export const NEST_INDENT = 16
/** Vertical gap between the focal node and anything stacked under it in
 *  its own band. Wider than CARD_GAP: what sits under the focus is not
 *  another row of it. */
export const CONTAINS_STACK_GAP = 18

/**
 * What a frame's SCROLL WINDOW knows — derived, so the layout that sizes
 * the frame, the view that draws the rows, and the consumer that fetches
 * the next page can never disagree about where the reader is.
 *
 * `total` is a FLOOR whenever `exact` is false: with pages still on the
 * server the honest statement is "of 40+", not a guess at the rest.
 */
export function frameWindow(card: FocusCard) {
  const size = Math.max(1, card.frameWindowSize)
  // `frameTotal` is the CONTAINER's child count — every column of the
  // table, not the connected ones. It only describes the frame's extent
  // in "everything inside" mode. Applying it in Connected mode said
  // "3 connected · showing 1–12 of 428" over three rows, with 425 rows
  // that will never arrive (Connected mode has no further pages to
  // fetch).
  const exact = card.frameShowingAll ? card.frameTotal >= 0 : true
  // Rows that EXIST, as far as anything has said: what has loaded, or
  // the container's own count when it is larger (the rest is still on
  // the server). In "all" mode the connected children are appended to
  // the server's child list, so the roster can run past the container's
  // own count — hence the max rather than either one alone.
  const total = card.frameShowingAll
    ? Math.max(card.frameLoaded, card.frameTotal >= 0 ? card.frameTotal : 0)
    : card.frameLoaded
  // Rows the frame can actually PUT ON SCREEN right now. Scrolling can
  // never run past what has been fetched; reaching the end is what asks
  // for the next page.
  const loaded = card.frameLoaded
  const offset = Math.min(Math.max(0, card.frameOffset), Math.max(0, loaded - size))
  const from = loaded === 0 ? 0 : offset + 1
  const to = Math.min(offset + size, loaded)
  const hasMore = card.frameShowingAll && card.frameHasMore
  return {
    /** Rows that exist (a floor when `exact` is false). */
    total,
    /** Rows in hand — what the window can reach without a fetch. */
    loaded,
    offset,
    size,
    from,
    to,
    exact,
    hasMore,
    /** More rows than fit: the frame scrolls. */
    scrollable: loaded > size || hasMore,
    /** The window is resting on the last loaded row — the moment to ask
     *  the server for the next page. */
    atEnd: to >= loaded,
    /** The furthest the window may travel. */
    maxOffset: Math.max(0, loaded - size),
  }
}

export type FocusCardKind = 'focal' | 'entity' | 'frame' | 'divider'

/**
 * Cards that HOLD ROWS: a container someone opened, and the FOCUS, which
 * is drawn in the same node language as its partners (R7) rather than as
 * a card with a detached panel of its own contents underneath it.
 *
 * One predicate, because "does this card host rows" decides three
 * different things that must agree: how tall it is, where its rows are
 * placed inside it, and whether the view renders it as a frame at all.
 */
export const holdsRows = (card: FocusCard): boolean =>
  card.kind === 'frame' || card.kind === 'focal'

/** How tall the header of a row-holding card is. A frame states a
 *  container; the FOCUS states the thing you asked about — its name,
 *  where it lives, and how far the walk has reached — so it carries the
 *  taller one. */
export const headerHeight = (card: FocusCard): number =>
  card.kind === 'focal' ? FOCAL_H : FRAME_HEADER_H

/** One row a frame holds, in order — enough for the view to run a
 *  type-ahead and move a keyboard cursor over rows the window has
 *  scrolled past, without every row having to be a card on the board. */
export interface FrameRowRef {
  urn: string
  label: string
  /** It holds things, so the keyboard's "open inside" means something
   *  here. False for a leaf — an affordance offered over a leaf is a
   *  key press that does nothing. */
  canOpen: boolean
}

/** Shared empty row list, so a card without rows never churns a memo. */
export const NO_FRAME_ROWS: ReadonlyArray<FrameRowRef> = Object.freeze([])

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
  /** How much more lineage is out there this way, in CONNECTIONS — the
   *  unit every other number on the board uses (band headers, a card's
   *  ×N, the focal's in/out). One unit in all three states on purpose:
   *  counting groups in one and connections in another put two meanings
   *  in one place on one card, and the badge read as changing its mind
   *  about the size of what was out there. `null` only where the data
   *  source genuinely did not say. */
  count: number | null
  /** Reveal only: how many CARDS one click puts on the board. The wording
   *  needs it — a page is a page of groups, not of hops — and the badge
   *  must never be it. */
  groups?: number
  /** T23 R3 — reveal only: this key's WHOLE ranking (already-admitted
   *  groups plus `groups` above), regardless of how many pages a reader
   *  has already opened. The hub-triage threshold reads THIS, not
   *  `groups`: "does this control's own delivery ever exceed ~3 pages"
   *  is a stable fact about the control, not one that flickers back
   *  under the threshold the moment a reader has already clicked it
   *  once. Absent for `extend`/`page`, where `count` already means this
   *  (nothing is admitted from a frontier before it fires). */
  groupsTotal?: number
  key: string
  cursor?: string
  status?: 'loading' | 'error'
}

/**
 * T23 R3 — one partner a hub-triage list can place on the board: a
 * direct lineage neighbour of the anchor, already named in the walk
 * model (an unfetched partner has no urn yet — the list's own header
 * states the unfetched remainder separately, off the pill it opened
 * from). Weight-sorted, and carrying its own containment ROOT (not just
 * its immediate parent) so "All, grouped by system" rolls up the way
 * the orientation sentence's own "across N systems" already does
 * (`distinctSystemCount`) — one definition of "system" everywhere.
 */
export interface LensNeighbor {
  urn: string
  label: string
  type: string
  /** Raw hops between this partner and the anchor side. */
  weight: number
  /** The one relationship type these hops share, '' when they differ. */
  edgeTypeNorm: string
  parentUrn: string | null
  parentLabel: string | null
  /** The top-level containment root this partner sits under. */
  systemUrn: string
  systemLabel: string
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
  /** Distinct top-level systems `up`/`down` are spread across — what the
   *  focal's orientation sentence reads for "across N systems". Absent
   *  from a plain hop count: 12 upstream sources in one warehouse and 12
   *  spread across a dozen platforms are a different picture entirely. */
  upSystems: number
  downSystems: number
}

export interface FocusCard {
  /** Stable across rebuilds AND across a `kind` flip (T27 — a card
   *  never changes id when it gains or loses its first child, or its
   *  React Flow node remounts): 'f' | n:urn */
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
  /** When the data source last synced this entity, VERBATIM off the
   *  payload (`lastSyncedAt`), null when it never said. Kept raw so the
   *  layout stays a pure function of its inputs — formatting it here
   *  would make two builds of one picture differ by the clock. */
  freshness: string | null
  /** Entity type id; 'not loaded' when the walk could not resolve one. */
  type: string
  parentId: string | null
  parentLabel: string | null
  /** Raw hops this card's subtree carries to the rest of the picture. */
  count: number
  /** Hops the walk model holds AT THIS ENTITY, per side — the sentence a
   *  row states in words when you point at it ("17 flows · 12 in / 5
   *  out"). Straight off the model's own degree, so it counts the same
   *  hops the wires do; 0/0 for a row the walk never reached (a roster
   *  extra), which is exactly the "no lineage" case. */
  flowsIn: number
  flowsOut: number
  /** This row's frame holds more than one kind of thing, so the row says
   *  which it is. In a frame of eight columns the chip would be eight
   *  identical labels; in a frame of columns AND views it is the answer. */
  showType: boolean
  /** The one relationship type this card's hops share, '' when they
   *  differ or it carries none. */
  edgeTypeNorm: string
  /** The nesting frame's own `id` (`n:${urn}`, or `'f'` for the focus),
   *  else null. */
  frameId: string | null
  /** Nesting level, 0 for a top-level card. Drives the indent; the tree
   *  itself is derived, never stored. */
  depth: number
  /** Frame cards only — opened, and nothing inside connects to the focal. */
  frameEmpty: boolean
  /** Frame cards only — how many vertical lanes its left gutter has to
   *  reserve for the lineage that stays INSIDE it. 0 for every frame
   *  whose contents don't feed each other, which costs it nothing. */
  gutterLanes: number
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
  /** Frame cards only, Find active (F2) — the size of the space actually
   *  searched: every connected participant (always exact — nothing here
   *  is paginated) plus, once the server has answered THIS query, its
   *  own reported extent. A floor (`frameSearchedExact: false`) rather
   *  than a guess whenever the roster hasn't finished paging or never
   *  declared a total — the same honesty `frameTotal` already keeps. */
  frameSearchedCount: number
  frameSearchedExact: boolean
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
  /** Frame cards only — the first row on screen (0-based row index),
   *  already clamped to what has actually loaded. The frame shows ONE
   *  window at a time so a 500-column table and a 5-column one occupy
   *  the same room: rendering every row instead grew the frame past
   *  ~2,000px and multiplied the card count with every open. Scrolling
   *  MOVES this window; it never grows the frame. */
  frameOffset: number
  /** Frame cards only — rows the window holds. */
  frameWindowSize: number
  /** Frame cards only — every row it holds, in order, whether or not the
   *  window is currently on it. The board draws only the window; the
   *  keyboard cursor and the type-ahead need the whole list. */
  frameRows: ReadonlyArray<FrameRowRef>
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
  /** A wire actually lands on this card, so it needs the ports one
   *  anchors to. False for a card nothing connects to in this picture —
   *  a roster extra, or a contains-stack row whose lineage is drawn at
   *  the focal above it. Two coloured dots that no line ever reaches
   *  read as a connection the reader then goes looking for. */
  wired: boolean
  /** The walk reached this card and NOTHING further exists beyond it —
   *  a claim about the data source, made only once the walk says so. */
  deadEnd: boolean
  /** T24 F6 — `'unsupported'` used to map to `null` (the SAME value an
   *  entity never asked at all carries), so a provider that cannot list
   *  contents rendered nothing at all: no spinner, no error, no retry —
   *  the frame just sat there, wired but dead. */
  fetch: 'loading' | 'error' | 'unsupported' | null
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
  /** T23 R2 — this card is the visible BOUNDARY of a maximal degree-1
   *  pass-through run that is currently UNFOLDED (its interior cards are
   *  drawn); the re-condense control renders here. Null/absent while the
   *  run is condensed (there is nothing to fold back) or this card
   *  borders no run. */
  condenseRun?: FocusCondenseRunInfo | null
}

/** T23 R2 — the run a boundary card's re-condense control folds back. */
export interface FocusCondenseRunInfo {
  connectorId: string
  dir: 'in' | 'out'
  /** Interior cards the run hides once condensed. */
  steps: number
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
  /** The ONE wire of this loop whose badge outranks the density cap.
   *
   *  Every wire of a loop is marked (which of them "closes" it is an
   *  artefact of the walk order), and on a cyclic estate that is a badge
   *  on every wire on the board. So the rest of them answer to density
   *  like any other badge, and exactly one — the lowest edge id in the
   *  loop, so the choice is the same on every render — is guaranteed:
   *  a loop is never invisible, and never carpets the board. */
  cycleAnchor: boolean
  /** This bundle's ×N badge has something to say AND somewhere to sit:
   *  more than one raw hop (or a cycle to mark), a drawn line long
   *  enough to hold a pill, and no other badge already occupying that
   *  spot. Decided here rather than in the view because it is a question
   *  about GEOMETRY, and the geometry is what this module computes —
   *  badges on short, overlapping wires read as confetti floating over
   *  the board rather than as labels belonging to a line. */
  labelVisible: boolean
  /** Where along the straight line between this wire's own ports its
   *  badge/seam chip sits, 0..1. 0.5 (the plain midpoint) unless another
   *  label already claimed that spot — see `labelVisible`'s own doc
   *  comment on the collision this exists to resolve (T22, R3). */
  labelT: number
  /** This wire is NOT column-certain: at least one bundled hop's own
   *  endpoint HOLDS THINGS (known children, or a declared/roster total —
   *  the same `heldTotal` signal R7's `isFrame` reads), so the data
   *  source reported it at a grain coarser than the finest the model
   *  could show — or the endpoint IS a rolled-up ancestor for the same
   *  reason. Never true for a hop that names two leaves, whatever view
   *  state it happens to render through — see `holdsThings`. Cone-only
   *  in the view: the un-isolated board's bundles are unchanged (T22,
   *  R1 rule 2). */
  grainCoarse: boolean
  /** The nearest drawn ancestor FRAME both of this wire's cards sit
   *  under, or null. When set, the wire routes INSIDE that frame's own
   *  bounds rather than the ordinary bezier — the geometry is convex, so
   *  a straight line between two points already inside it can never
   *  leave it (T22, R2). */
  sameAncestorFrame: string | null
  /** INTERNAL FLOW IS VERTICAL. This wire stays inside
   *  `sameAncestorFrame` AND that frame reserved it a lane in its own
   *  left gutter: leave the producer's left port, drop down the lane at
   *  `x`, turn back in at the consumer's left port. `index` is the
   *  lane's own slot (0 = innermost, hugging the rows); `x` is its
   *  absolute centre, resolved once the frame has a position.
   *
   *  Null means the plain router: either the wire leaves its frame (the
   *  ordinary horizontal case) or the frame ran out of lanes, which is
   *  a density the quiet treatment below already answers. */
  inFrameLane: { index: number; x: number } | null
  /** A grain-coarse wire found a collision-free slot for its seam badge
   *  in the SAME placement pass `labelVisible` comes from. `false` means
   *  every candidate along this wire's own length collided with an
   *  already-placed label — the view must not fall back to drawing the
   *  badge at a stale/default position anyway, which is the exact
   *  overlap R3 exists to prevent, just for a seam badge instead of a
   *  ×N one (T22, R3 fix round 1). The wire's own muted/dashed treatment
   *  is unaffected — only the badge is withheld. */
  seamSlotted: boolean
  /** T23 R2 — this edge stands for a condensed maximal degree-1
   *  pass-through run: draw the "— via N steps —▶" connector chip
   *  instead of a plain ×N badge. `count` above is still the honest sum
   *  of the run's own interior raw hops — condensing never changes what
   *  a number means, only how many cards it took to get there. */
  condensed?: { connectorId: string; steps: number } | null
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
  /** The layout could not place the focus and drew it as a last resort.
   *  Always false in a healthy picture; when it is true the board is
   *  showing the focus alone and has to say so, because everything else
   *  the walk knows about is missing from it. */
  focusRecovered: boolean
  /** Every containment level this view state has drawn THROUGH, this
   *  build and every earlier one. The consumer folds it back into
   *  `LensViewState.walkedThrough`; see the note there for why the grain
   *  has to be sticky. */
  walkedThrough: ReadonlySet<string>
  /** Where every entity drawn so far SITS, by first-draw order. The
   *  consumer folds it back into `LensViewState.drawnRank`; a card on the
   *  board never moves because the walk grew under it. */
  drawnRank: ReadonlyMap<string, number>
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
  const frameById = new Map(cards.filter(holdsRows).map(c => [c.id, c]))
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
    const head = headerHeight(c)
    // Room for the range chip and the step control, but only where the
    // list actually windows: a frame showing everything it has needs no
    // strip saying so.
    const foot = frameWindow(c).scrollable ? FRAME_FOOTER_H : 0
    c.w = CARD_W + FRAME_PAD * 2 + gutterWidth(c.gutterLanes)
    // A COLLAPSED frame is its header and nothing else. Reserving a
    // body row is for a frame that is open and has none yet — loading,
    // empty, failed — which all need somewhere to say so.
    c.h = kids.length === 0 && !c.childrenOpen
      ? head
      : head + FRAME_PAD + Math.max(inner, kids.length === 0 ? CARD_H : 0) + FRAME_PAD + foot
  }
  // Children FILL their frame, and a nested frame is wider still (it
  // carries its own padding), so each host widens to hold what it holds.
  for (const { f: c } of frames) {
    const kids = childrenByFrame.get(c.id) ?? []
    for (const k of kids) if (k.kind !== 'frame') k.w = FRAME_CONTENT_W
    const widest = kids.reduce((acc, k) => Math.max(acc, k.w), FRAME_CONTENT_W)
    // The gutter is INSIDE the frame and to the left of its rows, so the
    // box grows by it and the rows do not shrink: a container that
    // routes its own lineage is wider, never tighter.
    c.w = widest + FRAME_PAD * 2 + gutterWidth(c.gutterLanes)
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
      // The FOCAL node centers on the midline and owns the column's own
      // x; anything else that lands in this band hangs below it,
      // indented. Keyed on the KIND rather than on position: the focal
      // is what the midline is for, and "whatever happens to be first"
      // decorated a different card entirely the one time the focus went
      // missing from its own band.
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
    let y = frame.y + headerHeight(frame)
    const gutter = gutterWidth(frame.gutterLanes)
    for (const k of kids) {
      k.x = frame.x + FRAME_PAD + gutter
      k.y = y
      y += k.h + CARD_GAP
    }
  }
}
