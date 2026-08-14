/**
 * FocusGraphView — the Lens's interactive Graph mode renderer.
 *
 * A self-contained React Flow instance (own provider — never shares
 * viewport state with GraphCanvas) that renders the pure layout build as
 * rich entity cards in hop bands. All semantics live in
 * focus-layout.ts; this file is presentation and gestures only:
 *   single click  = select (detail strip)     double click = focus
 *   ▸ chevron     = show/hide what is inside   pane click   = deselect
 *   hover a card  = light up its connections
 *   drag a card   = rearrange it; a frame carries its children
 *   breadcrumb    = re-center a level above this one
 *   ⊕ pill        = grow the walk from this card — reveal what is
 *                   already loaded, page a partial adjacency, or fetch
 *                   one hop further out
 *
 * Positions come pre-baked from the builder, so React Flow does no
 * layout of its own — card ids are stable across rebuilds and a CSS
 * transform transition (killed under .reduce-motion) makes shared
 * cards glide when the focal changes. Anything the user drags is held
 * in a per-focal overlay ON TOP of that layout, so an arriving fetch
 * grows the picture without discarding the arrangement; "Tidy up" in
 * the corner controls drops the overlay. Frame children ride along as
 * React Flow child nodes (parentId), which is what makes a frame move
 * as one piece and its edges re-route themselves.
 *
 * PERF CONTRACT — the graph must stay snappy while browsing, so no
 * frequent interaction may rebuild the node or edge arrays:
 *   • hover   → HoverContext; the edges array keeps its identity and
 *               only the SVG paths re-render.
 *   • reach   → ReachContext; a growing walk re-renders the focal
 *               card alone, not all N nodes.
 *   • select  → React Flow's own `selected` flag, node identity kept
 *               for every unaffected card.
 *   • rebuild → cards memo on card CONTENT, not on the freshly-built
 *               object's identity, so an arriving fetch re-renders only
 *               the cards that actually changed.
 *   • visuals → resolved once per schema, O(1) per card, no per-card
 *               store subscription.
 *   • drag    → React Flow moves the card during the gesture; only the
 *               FINAL position is committed, so a drag costs one state
 *               update rather than one per animation frame.
 * The viewport re-frames on FOCAL change only: expanding grows the
 * picture in place instead of yanking it away from what you opened.
 */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  getBezierPath,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as LucideIcons from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import { getEntityVisual } from '@/hooks/useEntityVisual'
import { generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { CARD_W, BAND_GAP, FRAME_HEADER_H, FRAME_PAD, frameWindow, edgeLabelFor, type EdgeTypeInfoMap, type FocusCard, type FocusGraph, type FocusPill, type LensReach } from './focus-cards'
import { REVEAL_PAGE, pathToFocus, buildWalkExport, walkExportToCsv, type LensDirectionFilter } from './focus-layout'
import { timeAgo } from '@/lib/timeAgo'
import { FIT_MAX_ZOOM, useFrameCamera } from './useFrameCamera'

/** Direction tints — the house semantics: upstream = sky, downstream
 *  = amber (matches the list columns and the canvas). */
const TINT_UP = '#0ea5e9'
const TINT_DOWN = '#f59e0b'

/** Slate, for a card that stands for no entity: an unresolved type, or
 *  the focal's contains-stack, which is chrome rather than a thing. */
const NEUTRAL_ACCENT = '#94a3b8'

/**
 * Live interaction values delivered by CONTEXT rather than through node
 * data — the difference between a snappy graph and a sluggish one.
 *
 * Hover emphasis and the focal's reach line both change often and
 * matter to a tiny slice of the graph, but folding them into node/edge
 * data made every change rebuild the whole nodes or edges array, which
 * React Flow then reconciled element by element. Routed through
 * context, a hover re-renders only the edge paths, and a growing walk
 * re-renders only the focal card. The arrays keep their identity.
 */
const HoverContext = createContext<string | null>(null)
const ReachContext = createContext<LensReach | null>(null)
/**
 * Path-to-focus highlight — every card/edge id on SOME path between the
 * hovered-with-intent (or selected) card and the focus (see
 * `pathToFocus` in focus-layout.ts). `null` = no active highlight,
 * meaning nothing dims — the SAME "no path: don't touch the picture"
 * contract `pathToFocus` itself returns for an unreachable card.
 * Context, not card/edge data: hovering must re-render the affected
 * cards/edges alone, never rebuild the arrays (see the PERF CONTRACT
 * above) — the same reason HoverContext/ReachContext exist.
 *
 * `source` is which gesture asked, and it decides how much the picture
 * is allowed to change. A HOVER only strengthens the path — moving the
 * pointer across the board must never wash the board out. A SELECTION
 * is deliberate, so it may quiet what is off the path, but only to a
 * floor that keeps every label readable.
 */
const PathHighlightContext = createContext<{
  cardIds: ReadonlySet<string>
  edgeKeys: ReadonlySet<string>
  source: 'hover' | 'select'
} | null>(null)

/**
 * Where the KEYBOARD is: which frame is being browsed, and which of its
 * rows the cursor is resting on.
 *
 * Context for the same reason hover and reach are — arrowing down a
 * 400-row table must re-render the two rows whose cursor state changed,
 * never rebuild the nodes array. `frameKey` is the frame's own key (an
 * entity urn), so a row can tell "the cursor is on ME" from "the cursor
 * is on a row of some other frame that happens to share my urn" — which
 * a diamond genuinely can produce.
 */
const RowCursorContext = createContext<{ frameKey: string; urn: string } | null>(null)

/** Off the highlighted path, under a SELECTION. Quiet enough to read as
 *  background, light enough that every name is still legible — the old
 *  30% turned the rest of the board into grey ghosts. */
const OFF_PATH_CARD = 'opacity-60'
const OFF_PATH_EDGE = 0.3

/** Above this many labelled bundles on one board, a ×N badge stops being
 *  information and becomes texture — so only the ones the reader is
 *  pointing at (hovered, selected, on the highlighted path) keep theirs. */
const LABEL_DENSITY_CAP = 12

/** Shared empty overlay — a fresh Map would churn the nodes memo. */
const EMPTY_POSITIONS: ReadonlyMap<string, XYPosition> = new Map()

interface CardCtx {
  edgeTypeInfo?: EdgeTypeInfoMap
  /** The entity the whole picture is about. Always a compact FOCAL card
   *  — what it holds is the contains-stack attached below it — so this
   *  is here for the cards that need to know which one it is, not for
   *  the focal's own chrome. */
  focalId: string
  /** type id → {color, icon}, resolved ONCE for the whole graph. Cards
   *  used to each subscribe to the schema store and linear-scan the
   *  entity-type list, so every card paid for every schema touch. */
  visualFor: (typeId: string) => { color: string; Icon: LucideIcons.LucideIcon }
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  /** Open / close what a card holds. Free: a re-projection over the
   *  walk model, never a fetch. */
  onToggleFrame: (expandKey: string) => void
  /** Rest a frame's scroll window on row `offset` (0-based, absolute),
   *  fetching the next server page as the window nears what has loaded.
   *  The VIEW clamps — it is the side that knows how many rows there
   *  are — so a wheel spun past the end never banks an offset the frame
   *  would then have to scroll back through. */
  onFrameScroll: (openKey: string, offset: number) => void
  /** A wheel gesture over a frame, in raw pixels. Resolved to whole rows
   *  and clamped where the row count lives (the built graph), so a row —
   *  which knows only which frame it is in — can simply hand the delta
   *  over. */
  onFrameWheel: (openKey: string, deltaPx: number) => void
  onFrameQuery: (openKey: string, q: string) => void
  /** Current text typed into a frame's own filter. */
  frameQueryFor?: (openKey: string) => string
  /** Flip one frame between "only what connects" and "everything inside". */
  onToggleFrameAll?: (openKey: string) => void
  /** Re-kick a failed "everything inside" fetch. */
  onRetryFrameAll?: (openKey: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
  /** Move the keyboard cursor inside a frame. `urn` null parks it. */
  onRowCursor: (frameKey: string, urn: string | null) => void
  // ── Growing the walk ─────────────────────────────────────────────
  // Optional so a caller can render a picture it does not intend to be
  // grown (the visual harness does exactly that); the ⊕ renders only
  // where the layout put one.
  /** Show the next page of neighbours ALREADY in the walk model —
   *  a re-projection, never a fetch. Keyed `${'in'|'out'}:${urn}`. */
  onRevealMore?: (key: string) => void
  /** Fetch one further hop from this card, in this direction. */
  onExtend?: (key: string, nodeId: string, dir: 'in' | 'out') => void
  /** Page a partially-loaded adjacency further, with the server's own
   *  cursor carried back verbatim. */
  onPage?: (nodeId: string, dir: 'in' | 'out', cursor: string) => void
}

interface FocusGraphViewProps {
  graph: FocusGraph
  focalId: string
  /** Focal in/out tallies (record counts — groups don't hide them). */
  focalStats: { in: number; out: number }
  /** Focal fetch state — drives the empty-direction whispers. */
  focalFetch?: 'loading' | 'done' | 'error'
  /** How far the walk has reached; null while it is still walking. */
  focalReach?: LensReach | null
  /** Filename stem for the PNG/data export. */
  exportName?: string
  /** The header's direction preset — an empty band it CAUSED must say
   *  so, never "no lineage in the data source" (that is the filter's
   *  doing, not a fact about the source). Defaults to 'both'. */
  directionFilter?: LensDirectionFilter
  selectedId: string | null
  reducedMotion: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onSelect: (nodeId: string | null) => void
  onFocus: (nodeId: string) => void
  onToggleFrame: (expandKey: string) => void
  onFrameScroll: (openKey: string, offset: number) => void
  onFrameQuery: (openKey: string, q: string) => void
  frameQueryFor?: (openKey: string) => string
  onToggleFrameAll?: (openKey: string) => void
  onRetryFrameAll?: (openKey: string) => void
  onRevealOnCanvas?: (nodeId: string) => void | Promise<void>
  onOpenDetails?: (nodeId: string) => void
  onRevealMore?: (key: string) => void
  onExtend?: (key: string, nodeId: string, dir: 'in' | 'out') => void
  onPage?: (nodeId: string, dir: 'in' | 'out', cursor: string) => void
}

const iconByName = (name: string): LucideIcons.LucideIcon =>
  (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[name] ?? LucideIcons.Box

/**
 * Where this card stands in the current highlight: ON the path (say so
 * with a ring), off it under a SELECTION (quiet it, to a floor), or
 * untouched — which is every card while the gesture is only a hover.
 */
function usePathState(cardId: string): { onPath: boolean; offPath: boolean } {
  const highlight = useContext(PathHighlightContext)
  if (highlight === null) return { onPath: false, offPath: false }
  const onPath = highlight.cardIds.has(cardId)
  return { onPath, offPath: !onPath && highlight.source === 'select' }
}

/** Flat equality over a built card. Every field is a primitive, a frozen
 *  string array, or one of the walk builder's small records, so this is
 *  exact and cheap enough to run per card per rebuild. */
function sameCard(a: FocusCard, b: FocusCard): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof FocusCard>
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (k === 'ancestry' || k === 'ancestryIds') {
      const x = a[k], y = b[k]
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false
      continue
    }
    // The builder returns fresh records every rebuild, so these have to
    // be compared by VALUE — by reference they would never match and
    // the memo boundary this function exists for would be gone.
    if (k === 'pillUp' || k === 'pillDown') {
      const x = a[k] ?? null, y = b[k] ?? null
      if (x === null || y === null) { if (x !== y) return false; continue }
      if (x.kind !== y.kind || x.count !== y.count || x.key !== y.key
        || x.cursor !== y.cursor || x.status !== y.status) return false
      continue
    }
    if (k === 'contents') {
      const x = a[k] ?? null, y = b[k] ?? null
      if (x === null || y === null) { if (x !== y) return false; continue }
      if (x.onLineage !== y.onLineage || x.total !== y.total) return false
      continue
    }
    // A frame's whole row list. Compared by VALUE like the rest — and
    // cheaply, because the list is flat: a wide table rebuilds 400 tiny
    // records, and a memo that missed here would re-render every frame
    // on the board for every keystroke.
    if (k === 'frameRows') {
      const x = a[k], y = b[k]
      if (x === y) continue
      if (x.length !== y.length) return false
      if (x.some((v, i) => v.urn !== y[i].urn || v.label !== y[i].label)) return false
      continue
    }
    if (a[k] !== b[k]) return false
  }
  return true
}

// ── Card node ────────────────────────────────────────────────────────

function TypeIcon({ ctx, typeId, color, className }: { ctx: CardCtx; typeId: string; color: string; className?: string }) {
  const Icon = ctx.visualFor(typeId).Icon
  return <Icon className={className} style={{ color }} />
}

/** The tiny colored connection dots edges anchor to: incoming on the
 *  left (sky), outgoing on the right (amber). Two, because lineage is
 *  the only thing drawn as a wire — containment nests instead. */
function PortHandles() {
  const dot = '!w-1.5 !h-1.5 !border-0 !min-w-0 !min-h-0 rounded-full'
  return (
    <>
      <Handle type="target" position={Position.Left} className={dot} style={{ backgroundColor: `${TINT_UP}99` }} />
      <Handle type="source" position={Position.Right} className={dot} style={{ backgroundColor: `${TINT_DOWN}99` }} />
    </>
  )
}

/**
 * Where this entity lives — its OWNER, readably, and the rest on hover.
 *
 * `int_clean_orders_t1` and `int_clean_orders_t2` both rendered as
 * `int_clean_order…` in an 80px end-truncated label, so a column's owner
 * was genuinely unreadable. The first attempt showed the whole chain
 * middle-truncated and made it worse: on a 240px card the grandparent
 * took a fixed slice at the front and squeezed the owner — the only
 * part that answers the question — down to `TRA…`.
 *
 * So: one name, the owner, and clip the FRONT rather than the back,
 * because warehouse names differ at the end (`…_orders_t1` vs
 * `…_orders_t2`) far more often than at the start. Levels above it are
 * a depth mark and the title; they are context, not the answer.
 */
/** How many containment levels the focal states before eliding. Three
 *  fits a 240px card at 9.5px; the rest is one ⋯ and the tooltip. */
const BREADCRUMB_LEVELS = 3

/** A name clipped at the FRONT. `int_clean_orders_t1` and
 *  `int_clean_orders_t2` both end-truncate to `int_clean_orders…`,
 *  which is the whole "I can't tell where this column came from"
 *  complaint; `…clean_orders_t1` answers it in the same width. */
function TailName({ children, className, title }: { children: string; className?: string; title?: string }) {
  return (
    <span dir="rtl" className={cn('truncate min-w-0 text-left', className)} title={title ?? children}>
      <bdi>{children}</bdi>
    </span>
  )
}

/**
 * Where the FOCAL lives — the whole chain, each level clickable.
 *
 * `Sales › Snowflake › OrderApp › PROD › fact_orders` is the six-level
 * case stated plainly. This is the plan's "levels above the grain are a
 * breadcrumb, not geometry": nesting six frames costs ~400px of chrome
 * before any content, one line of text costs 12px, and the text is the
 * more useful of the two because every step is a place you can go.
 *
 * Deepest levels first in priority: the tail is what identifies the
 * entity, so the chain elides from the LEFT when it will not fit.
 */
function FocalBreadcrumb({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  const chain = card.ancestry.length > 0 ? card.ancestry : card.parentLabel ? [card.parentLabel] : []
  if (chain.length === 0) return null
  // Decide what fits HERE, not in CSS. Two attempts at leaning on flex
  // overflow produced a chain in reverse and a chain of `…flake ›
  // …EDIATE_T1`; a rule you can state in one line beats a layout you
  // have to screenshot to understand. The deepest levels identify the
  // entity, so those are the ones kept.
  const shown = chain.slice(-BREADCRUMB_LEVELS)
  const elided = chain.length - shown.length
  const idOf = (i: number) => card.ancestryIds[chain.length - shown.length + i] ?? card.parentId ?? ''
  return (
    <p
      className="flex items-center gap-1 min-w-0 text-[9.5px] text-ink-muted"
      title={`in ${chain.join(' › ')}`}
    >
      <LucideIcons.CornerLeftUp className="w-2.5 h-2.5 flex-shrink-0" />
      {elided > 0 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onFocus(card.ancestryIds[0] ?? '') }}
            title={`${elided} level${elided === 1 ? '' : 's'} above: ${chain.slice(0, elided).join(' › ')}`}
            className="nodrag flex-shrink-0 text-ink-muted/50 hover:text-accent-lineage transition-colors"
          >
            ⋯
          </button>
          <span className="flex-shrink-0 text-ink-muted/40" aria-hidden>›</span>
        </>
      )}
      {shown.map((level, i) => {
        // The DEEPEST level identifies the entity — it is the whole
        // difference between `int_clean_orders_t1` and `_t2` — so it
        // never gives up room. Shallower levels are context and yield
        // first; the tooltip keeps the chain whole either way.
        //
        // The rule has to sit on the WRAPPER, not just the button: a
        // shrinkable wrapper clips an unshrinkable child, which is how
        // an earlier attempt still rendered `int_clean_or…`.
        const deepest = i === shown.length - 1
        return (
          <span
            key={`${level}-${i}`}
            className={cn('flex items-center gap-1', deepest ? 'flex-shrink-0' : 'min-w-0')}
          >
            {i > 0 && <span className="flex-shrink-0 text-ink-muted/40" aria-hidden>›</span>}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); ctx.onFocus(idOf(i)) }}
              className={cn(
                'nodrag hover:text-accent-lineage transition-colors',
                deepest ? 'whitespace-nowrap text-ink-muted' : 'truncate min-w-0 text-ink-muted/60',
              )}
            >
              {level}
            </button>
          </span>
        )
      })}
    </p>
  )
}

/**
 * The containment above a TOP-LEVEL frame, as a chip beside its name:
 * `int_clean_charges_t1  in SILVER · Snowflake`.
 *
 * This is the other half of "no passive wrappers": the levels the layout
 * walked through to reach this entity are never drawn as boxes, so they
 * have to be SAID, or a frame called `clean_charges` in the upstream
 * column has lost the fact that it lives in SILVER. Twelve pixels of
 * text instead of ~90px of nesting chrome per level, and every crumb is
 * somewhere you can go.
 *
 * Deepest first — the owner is what distinguishes `int_clean_orders_t1`
 * from `_t2`, so it leads and never gives up room; the levels above it
 * are context and truncate. Only ever on a top-level frame: nested
 * inside its parent, the level above is the header two pixels up.
 */
function FrameAncestry({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  const chain = card.ancestry.length > 0 ? card.ancestry : card.parentLabel ? [card.parentLabel] : []
  if (card.frameId !== null || chain.length === 0) return null
  // A frame header has ~130px beside the name: two SHORT names fit, and
  // three came out as `in CURATED · P… · Ris…` — three names, none of
  // them readable. So both levels are named when both are all there is
  // (`in SILVER · Snowflake`, the reported case), and anything deeper is
  // the owner plus one ⋯ — the tooltip carries the chain either way.
  const deepestFirst = [...chain].reverse().slice(0, chain.length === 2 ? 2 : 1)
  const elided = chain.length - deepestFirst.length
  // By POSITION, never by label: two levels of one estate are routinely
  // called the same thing (`PROD ⊃ … ⊃ PROD`), and looking the crumb up
  // by its text sent the click to whichever one came first.
  const idFor = (i: number) => card.ancestryIds[chain.length - 1 - i] ?? card.parentId ?? ''
  const title = `in ${chain.join(' › ')}`
  return (
    <span className="flex items-baseline gap-1 min-w-0 text-[9px] text-ink-muted/70" title={title}>
      <span className="flex-shrink-0">in</span>
      {deepestFirst.map((level, i) => (
        <span key={`${level}-${i}`} className={cn('flex items-baseline gap-1', i === 0 ? 'flex-shrink-0' : 'min-w-0')}>
          {i > 0 && <span className="flex-shrink-0 text-ink-muted/40" aria-hidden>·</span>}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onFocus(idFor(i)) }}
            className={cn(
              'nodrag hover:text-accent-lineage transition-colors',
              i === 0 ? 'whitespace-nowrap' : 'truncate min-w-0',
            )}
          >
            {level}
          </button>
        </span>
      ))}
      {elided > 0 && (
        <span className="flex-shrink-0 text-ink-muted/50" aria-hidden>⋯</span>
      )}
    </span>
  )
}

/** Where a TOP-LEVEL card lives. Rows never carry one: inside a frame
 *  the header already names the owner, right above them, and repeating
 *  it on every row is the noise the frame was for. */
function ProvenanceRibbon({ card }: { card: FocusCard }) {
  if (card.ancestry.length === 0 && !card.parentLabel) return null
  const chain = card.ancestry.length > 0 ? card.ancestry : [card.parentLabel!]
  const owner = chain[chain.length - 1]
  return (
    <span className="flex items-center gap-1 min-w-0" title={`in ${chain.join(' › ')}`}>
      <LucideIcons.FolderTree className="w-2.5 h-2.5 flex-shrink-0 text-ink-muted/50" />
      {chain.length > 1 && (
        <span className="flex-shrink-0 text-ink-muted/40" aria-hidden>⋯›</span>
      )}
      <TailName className="text-ink-muted" title={`in ${chain.join(' › ')}`}>{owner}</TailName>
    </span>
  )
}

/**
 * Room a ⊕ owns at each end of a card, in px. Nothing else may be
 * positioned inside it.
 *
 * The hover toolbar used to sit at `right-1.5`, which is where a row's
 * downstream ⊕ is — and it appears on HOVER, i.e. exactly when the
 * pointer is on its way to that pill. One click landed on the toolbar's
 * own padding (a span with no handler), did nothing, and the user
 * clicked again: the reported "the + needs three clicks".
 */
const PILL_ZONE = 44

/** Where a card's ⊕ — or the mark that the walk ends — sits.
 *
 *  A top-level card hangs it OUTSIDE, in the band gap. Inside a frame
 *  there is no outside: the row's own edges are all the room there is,
 *  so it tucks IN. Straddling the row edge (what this used to do) put it
 *  on the frame's dashed border and 4px from the frame's own pill —
 *  two different controls reading as one smudge. */
const gutterPos = (inFrame: boolean, upstream: boolean): string =>
  inFrame
    ? (upstream ? 'left-1' : 'right-1')
    : (upstream ? 'right-full mr-1.5' : 'left-full ml-1.5')

/** Which ends of this card have something in the gutter. Its content
 *  keeps out of those — an absolutely-positioned pill over a truncating
 *  label is a name you cannot read and a control you cannot see. */
const gutterEnds = (card: FocusCard) => ({
  left: card.pillUp != null || (card.deadEnd && card.band < 0),
  right: card.pillDown != null || (card.deadEnd && card.band >= 0),
})

/**
 * A DOM id for a row, so its frame's listbox can OWN it and point at it.
 *
 * Rows are React Flow SIBLINGS of their frame, not DOM descendants, so
 * `aria-activedescendant` alone would name an element outside the
 * listbox; `aria-owns` is the sanctioned way to state the relationship
 * anyway. Scoped by the frame, because a diamond genuinely can put one
 * entity in two frames at once. The escape is injective (`_` escapes
 * itself), so two urns differing only in punctuation cannot collide.
 */
const domSafe = (s: string): string =>
  s.replace(/[^a-zA-Z0-9-]/g, c => `_${c.charCodeAt(0).toString(36)}`)
const rowDomId = (frameKey: string, urn: string): string =>
  `lens-row-${domSafe(frameKey)}-${domSafe(urn)}`

/** Hover action cluster shared by entity-ish cards. */
function CardActions({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.nodeId) return null
  const id = card.nodeId
  const btn = 'pointer-events-auto w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
  return (
    // pointer-events-none on the cluster, auto on the buttons: the gaps
    // between three 20px icons are not a hit target for anything, and
    // they used to swallow whatever click found them.
    <span
      style={{ right: PILL_ZONE }}
      className="nodrag pointer-events-none absolute -top-2.5 hidden group-hover:flex items-center gap-0.5 rounded-md bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm px-0.5 py-0.5 z-10"
    >
      <button
        type="button"
        title="Focus here — re-center the lens on this entity"
        onClick={(e) => { e.stopPropagation(); ctx.onFocus(id) }}
        className={btn}
      >
        <LucideIcons.Focus className="w-3 h-3" />
      </button>
      {ctx.onRevealOnCanvas && (
        <button
          type="button"
          title="Reveal on canvas"
          onClick={(e) => { e.stopPropagation(); void ctx.onRevealOnCanvas?.(id) }}
          className={btn}
        >
          <LucideIcons.Crosshair className="w-3 h-3" />
        </button>
      )}
      {ctx.onOpenDetails && (
        <button
          type="button"
          title="Open details"
          onClick={(e) => { e.stopPropagation(); ctx.onOpenDetails?.(id) }}
          className={btn}
        >
          <LucideIcons.PanelRight className="w-3 h-3" />
        </button>
      )}
    </span>
  )
}

/** "What's inside this?" — the containment gesture, on the card body.
 *
 *  Distinct from the ⊕, which answers the other question ("what connects
 *  to this next?"). They used to share one control whose meaning flipped
 *  with the card's grain, so an ordinary neighbour's columns were simply
 *  unreachable. A card may offer both, and each means one thing.
 *
 *  Always free: "what's inside" is a re-projection over the walk model
 *  already in hand, and the model's children are scoped to lineage
 *  participants — so expanding can never fetch, and can never reach
 *  outside the lineage. */
function ContentsChevron({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.canOpenChildren || !card.nodeId || !card.expandKey) return null
  const Icon = card.fetch === 'loading' ? LucideIcons.Loader2
    : card.childrenOpen ? LucideIcons.ChevronDown : LucideIcons.ChevronRight
  return (
    <button
      type="button"
      className="nodrag flex-shrink-0 -ml-1 w-4 h-full flex items-center justify-center text-ink-muted/50 hover:text-accent-lineage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
      // A disclosure: assistive tech needs the state, not just a tooltip.
      aria-expanded={card.childrenOpen}
      aria-label={card.childrenOpen ? `Hide what's inside ${card.label}` : `Show what's inside ${card.label}`}
      title={card.childrenOpen
        ? `Hide what's inside ${card.label}`
        : `Show what's inside ${card.label}`}
      onClick={(e) => { e.stopPropagation(); ctx.onToggleFrame(card.expandKey!) }}
    >
      <Icon className={cn('w-3 h-3', card.fetch === 'loading' && 'animate-spin')} />
    </button>
  )
}

/** The node a pill's click acts on. The key is `${dir}:${urn}`, and a
 *  PAGE names the node the server's cursor belongs to, which is not
 *  always the card the pill hangs off (a collapsed table's pill pages
 *  the column underneath it). */
const pillTarget = (key: string): string => key.slice(key.indexOf(':') + 1)

/**
 * The ⊕, in one of three states — and the state is the
 * whole point, because they cost different things and promise different
 * things:
 *
 *   reveal — show more of what is ALREADY downloaded. Instant, exact.
 *   page   — ask the server for the rest of THIS node's connections,
 *            with its own cursor.
 *   extend — walk one hop further out from here.
 *
 * A drained direction gets no pill at all rather than a control that
 * would do nothing; `WalkPills` stamps the end of the walk instead.
 */
function WalkPill({ card, pill, dir, ctx }: { card: FocusCard; pill: FocusPill; dir: 'in' | 'out'; ctx: CardCtx }) {
  const upstream = dir === 'in'
  // Upstream hangs off the left edge, downstream off the right: the pill
  // points the way the data flows, so a card carrying both is readable.
  const pos = gutterPos(card.frameId != null, upstream)
  // z-20 puts the ⊕ above the hover toolbar (z-10) wherever the two ever
  // meet again: the pill is the affordance, so it wins by rule rather
  // than by DOM order.
  const base = 'nodrag pointer-events-auto z-20 absolute top-1/2 -translate-y-1/2 flex items-center justify-center gap-0.5 h-5 rounded-full border text-[9.5px] font-semibold tabular-nums transition-colors'
  const side = upstream ? 'upstream' : 'downstream'
  const act = () => {
    if (pill.kind === 'reveal') ctx.onRevealMore?.(pill.key)
    else if (pill.kind === 'page' && pill.cursor) ctx.onPage?.(pillTarget(pill.key), dir, pill.cursor)
    else ctx.onExtend?.(pill.key, pillTarget(pill.key), dir)
  }

  if (pill.status === 'loading') {
    return (
      <span className={cn(base, 'w-5 bg-canvas-elevated border-accent-lineage/40', pos)}>
        <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage" aria-label={`Fetching ${side} lineage`} />
      </span>
    )
  }
  if (pill.status === 'error') {
    // Same key, same click: retry is the action that failed, not a
    // different one, so it cannot drift out of step with it.
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); act() }}
        title={`Couldn't fetch what's ${side} of ${card.label} — click to try again`}
        aria-label={`Retry fetching ${side} of ${card.label}`}
        className={cn(base, 'w-5 bg-canvas-elevated border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10', pos)}
      >
        <LucideIcons.AlertTriangle className="w-3 h-3" />
      </button>
    )
  }

  const n = pill.count
  // The badge is the REMAINDER; one click delivers a page of it. Saying
  // "show 18 more" over a control that shows twelve is a promise the
  // click cannot keep, so name both numbers when they differ.
  const thisClick = n != null ? Math.min(n, REVEAL_PAGE) : null
  const title = pill.kind === 'reveal'
    ? `Show ${thisClick?.toLocaleString()} more ${side}${n != null && n > REVEAL_PAGE ? ` (${n.toLocaleString()} waiting)` : ''} — already loaded, nothing to fetch`
    : pill.kind === 'page'
      ? `Load the rest of what is ${side} of ${card.label}${n != null ? ` (${n.toLocaleString()} more)` : ''}`
      : `Walk one hop further ${side} of ${card.label}${n != null ? ` (${n.toLocaleString()} more)` : ''}`
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); act() }}
      title={title}
      aria-label={title}
      className={cn(
        base,
        n != null ? 'px-1.5' : 'w-5',
        // Free (already in hand) reads as the lens's own accent; a fetch
        // is quieter, because it costs a round trip. Both backgrounds are
        // OPAQUE: a pill sits exactly where a hub's wires converge, and a
        // tinted-transparent one had thirteen edges running through it.
        pill.kind === 'reveal'
          ? 'bg-canvas-elevated border-accent-lineage/60 text-accent-lineage hover:border-accent-lineage hover:bg-accent-lineage/10'
          : 'bg-canvas-elevated border-black/15 dark:border-white/20 text-ink-muted hover:text-accent-lineage hover:border-accent-lineage/50',
        pos,
      )}
    >
      {upstream && <LucideIcons.Plus className="w-2.5 h-2.5" />}
      {/* A count only ever renders when the model actually knows one. */}
      {n != null && n.toLocaleString()}
      {!upstream && <LucideIcons.Plus className="w-2.5 h-2.5" />}
    </button>
  )
}

/** Both sides of a card, or — when neither side has anything left to
 *  offer — the mark that the walk genuinely ends here. */
function WalkPills({ card, ctx }: { card: FocusCard; ctx: CardCtx }) {
  if (!card.pillUp && !card.pillDown) {
    if (!card.deadEnd) return null
    const upstream = card.band < 0
    return (
      <span
        title={`No further ${upstream ? 'upstream' : 'downstream'} lineage in the data source — the walk ends here`}
        aria-label={`End of ${upstream ? 'upstream' : 'downstream'} lineage`}
        className={cn(
          'pointer-events-none z-20 absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-canvas-elevated border border-black/10 dark:border-white/15 text-ink-muted/50',
          gutterPos(card.frameId != null, upstream),
        )}
      >
        <LucideIcons.CircleSlash className="w-3 h-3" />
      </span>
    )
  }
  return (
    <>
      {card.pillUp && <WalkPill card={card} pill={card.pillUp} dir="in" ctx={ctx} />}
      {card.pillDown && <WalkPill card={card} pill={card.pillDown} dir="out" ctx={ctx} />}
    </>
  )
}

/** What is inside, at the only two grains that matter: how much of it is
 *  on this lineage, and how much there is altogether. "3 on this lineage
 *  · of 12" is the sentence that makes a collapsed container safe to
 *  leave collapsed. The total is omitted rather than guessed. */
function ContentsCount({ card }: { card: FocusCard }) {
  if (!card.contents) return null
  const { onLineage, total } = card.contents
  return (
    <span
      className="flex-shrink-0 tabular-nums"
      title={total != null
        ? `${onLineage.toLocaleString()} of the ${total.toLocaleString()} things inside ${card.label} carry lineage here`
        : `${onLineage.toLocaleString()} things inside ${card.label} carry lineage here`}
    >
      {onLineage.toLocaleString()} on this lineage{total != null ? ` · of ${total.toLocaleString()}` : ''}
    </span>
  )
}

/** How much of a wheel gesture makes one row of travel. Trackpads report
 *  a few px per frame and a mouse notch ~100, so this has to be small
 *  enough to feel continuous and large enough that one notch is not a
 *  jump. */
const WHEEL_PX_PER_ROW = 26

/**
 * ONE row language, for all three places children are browsed: the rows
 * inside a partner's frame, the focal's contains-stack, and the roster a
 * frame shows in "everything inside".
 *
 * They used to be two different renderings (a rich card squeezed into a
 * row, and a quiet dashed strip) that agreed about nothing — different
 * heights, different cues, one with a hover toolbar that landed on top of
 * the ⊕ beside it. A child is a child: icon, name, and the cues the model
 * can actually vouch for.
 *
 * Every cue is a fact already in hand, and each one earns its place:
 *   • the ×N badge — hops between this row and the picture, compact,
 *     with the same number spelled out in words on hover;
 *   • its own type, but only where the frame holds more than one kind;
 *   • its relationship, but only where its siblings do not share it;
 *   • what it holds ("3 on this lineage · of 12");
 *   • its description, last, in whatever room is left.
 * A row the walk never reached keeps the quiet "no lineage" treatment —
 * it is context, and it must never read as a connection.
 */
function FrameRow({ card, ctx, selected }: { card: FocusCard; ctx: CardCtx; selected: boolean }) {
  const { onPath, offPath } = usePathState(card.id)
  const cursor = useContext(RowCursorContext)
  // The frame a row sits in is its containment parent — a row is only
  // ever emitted among its own parent's children.
  const hostKey = card.parentId ?? ''
  const onCursor = cursor !== null && cursor.frameKey === hostKey && cursor.urn === card.nodeId
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  const dim = card.dimmed ? (card.connected ? 'opacity-30' : 'opacity-20') : offPath ? OFF_PATH_CARD : undefined

  const activate = () => ctx.onSelect(card.nodeId)
  // The ⊕ tucks INSIDE a row (there is no outside), so the content
  // yields exactly the room a pill owns and no label runs under one.
  const gutters = gutterEnds(card)
  const flows = card.flowsIn + card.flowsOut
  const words = flows > 0
    ? `${flows.toLocaleString()} flow${flows === 1 ? '' : 's'} · ${card.flowsIn.toLocaleString()} in / ${card.flowsOut.toLocaleString()} out`
    : null

  return (
    <div
      id={rowDomId(hostKey, card.nodeId ?? card.id)}
      // An option of its frame's listbox — see `rowDomId`. The frame is
      // the single tab stop; a row is reached with the arrow keys and
      // named by `aria-activedescendant`, so Tab never has to walk 400
      // columns to get past a table.
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      // A wheel anywhere over a frame scrolls it, and a row is what the
      // pointer is actually over. `nowheel` is what stops React Flow
      // zooming the board out from under the gesture.
      className={cn(
        'nowheel group relative flex items-center gap-2 rounded-lg px-2.5 cursor-pointer transition-colors focus-visible:outline-none',
        card.connected
          ? 'border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] hover:border-accent-lineage/50'
          // Inside this, but off the lineage: background by default, and
          // it lights up only when you point at it.
          : 'border border-dashed border-black/[0.08] dark:border-white/[0.09] bg-transparent hover:border-accent-lineage/40 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] opacity-60 hover:opacity-100',
        selected ? 'ring-2 ring-accent-lineage' : onCursor ? 'ring-2 ring-accent-lineage/60' : onPath && 'ring-1 ring-accent-lineage/70',
        dim,
      )}
      style={{
        width: card.w,
        height: card.h,
        ...(card.connected ? { borderLeftWidth: 3, borderLeftColor: accent } : {}),
        paddingLeft: gutters.left ? PILL_ZONE : undefined,
        paddingRight: gutters.right ? PILL_ZONE : undefined,
      }}
      onWheel={(e) => {
        e.stopPropagation()
        ctx.onFrameWheel(hostKey, e.deltaY)
      }}
      onClick={activate}
      onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
      title={`${card.label}${card.description ? ` — ${card.description}` : ''}${
        card.connected ? '' : ' — inside this, but no lineage with the focused entity'
      } · click for a preview, double-click to focus`}
    >
      {card.wired && <PortHandles />}
      <ContentsChevron card={card} ctx={ctx} />
      <div
        className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: card.connected ? `${accent}1f` : 'transparent' }}
      >
        <TypeIcon ctx={ctx} typeId={card.type} color={accent} className={cn('w-3.5 h-3.5', !card.connected && 'opacity-60')} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('truncate text-[12px] leading-snug', card.connected ? 'font-medium text-ink' : 'text-ink-secondary')}>
          {card.label}
        </p>
        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug min-w-0">
          {/* Which KIND of thing — only where the frame holds several. */}
          {card.showType && (
            <span
              className="flex-shrink-0 px-1 rounded uppercase tracking-wide font-semibold"
              style={{ backgroundColor: `${accent}1f`, color: accent }}
            >
              {card.type}
            </span>
          )}
          {card.edgeTypeNorm && card.edgeTypeNorm !== card.frameSharedEdgeType && (
            <>
              <span
                className="w-1 h-1 rounded-full flex-shrink-0"
                style={{ backgroundColor: generateEdgeColorFromType(card.edgeTypeNorm) }}
              />
              <span
                className="truncate uppercase tracking-wide"
                title={ctx.edgeTypeInfo?.get(card.edgeTypeNorm)?.description}
              >
                {edgeLabelFor(card.edgeTypeNorm, ctx.edgeTypeInfo)}
              </span>
            </>
          )}
          {card.count > 1 && (
            // Compact by default, spelled out when you point at it: "×17"
            // is scannable down a column of forty rows, and "17 flows ·
            // 12 in / 5 out" is what it MEANS.
            <span
              className="tabular-nums font-semibold text-ink-muted flex-shrink-0"
              title={words ?? `${card.count.toLocaleString()} connections to this entity`}
            >
              ×{card.count.toLocaleString()}
            </span>
          )}
          {card.contents && (
            <>
              {(card.showType || card.count > 1 || card.edgeTypeNorm) && <span className="text-ink-muted/40">·</span>}
              <ContentsCount card={card} />
            </>
          )}
          {card.description && (
            <span className="truncate min-w-0 italic text-ink-muted/60">{card.description}</span>
          )}
          {!card.connected && !card.description && (
            <span className="flex-shrink-0 text-ink-muted/50">no lineage</span>
          )}
        </p>
      </div>
      {/* A row that carries no lineage says so on its right edge, where
          a connected row shows its ⊕ — so the two read as one column of
          answers rather than as an absence. */}
      {!card.connected && card.description && (
        <span className="flex-shrink-0 text-[9px] text-ink-muted/50">no lineage</span>
      )}
      <WalkPills card={card} ctx={ctx} />
    </div>
  )
}

/** The quiet line between the rows that answer the question and the rows
 *  that merely live here. Not an entity, so it is not a card you can
 *  click — it is a sentence about the two groups either side of it. */
function FrameDividerNode({ data }: NodeProps) {
  const { card, ctx } = data as unknown as { card: FocusCard; ctx: CardCtx }
  return (
    <div
      className="nowheel flex items-center gap-2 px-1 select-none"
      style={{ width: card.w, height: card.h }}
      onWheel={(e) => { e.stopPropagation(); ctx.onFrameWheel(card.parentId ?? '', e.deltaY) }}
    >
      <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/[0.10]" />
      <span className="flex-shrink-0 text-[9px] text-ink-muted/70 tabular-nums">
        {card.label} — {card.count.toLocaleString()} item{card.count === 1 ? '' : 's'}
      </span>
      <span className="h-px flex-1 bg-black/[0.08] dark:bg-white/[0.10]" />
    </div>
  )
}

function FocusGraphCard({ data, selected }: NodeProps) {
  const { card, ctx, focalStats } = data as unknown as {
    card: FocusCard
    ctx: CardCtx
    focalStats?: { in: number; out: number; coarser: number }
  }
  // Reach arrives via context so a growing walk re-renders ONLY this
  // card — it used to invalidate every node in the graph.
  const focalReach = useContext(ReachContext)
  // Same reasoning for the path-to-focus highlight: a hover must re-
  // render only the cards whose highlight state actually changed.
  const { onPath, offPath } = usePathState(card.id)
  // One class, decided here: two `opacity-*` utilities on one element
  // are settled by their order in the stylesheet, not in the class list,
  // so the text filter's own dim and the path floor cannot both be
  // spelled out and left to fight.
  const dim = card.dimmed ? 'opacity-30' : offPath ? OFF_PATH_CARD : undefined
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color

  const activate = () => ctx.onSelect(card.nodeId)
  const keyActivate = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate() }
  }

  // ── Focal: the anchor card — bigger, gradient, in/out tally ──
  if (card.kind === 'focal') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={keyActivate}
        style={{
          width: card.w,
          height: card.h,
          borderColor: accent,
          background: `linear-gradient(150deg, ${accent}24, ${accent}08 60%)`,
          boxShadow: selected ? `0 10px 34px ${accent}55` : `0 10px 34px ${accent}33`,
        }}
        className={cn(
          'group relative rounded-xl border-2 px-3.5 py-2.5 bg-canvas-elevated cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          selected
            ? 'ring-2 ring-accent-lineage ring-offset-1 ring-offset-canvas-elevated'
            : onPath && 'ring-1 ring-accent-lineage/70',
          dim,
        )}
      >
        {card.wired && <PortHandles />}
        {/* The focus is where a walk starts, so both of its ⊕ live here
            — upstream on the left edge, downstream on the right. */}
        <WalkPills card={card} ctx={ctx} />
        <div className="flex items-center gap-1.5">
          <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5" />
          <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] truncate" style={{ color: accent }}>
            {card.type}
          </p>
          {card.fetch === 'loading' && (
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
          )}
        </div>
        <p
          className="text-[13.5px] font-semibold text-ink truncate leading-snug"
          title={`${card.label}${card.description ? ` — ${card.description}` : ''}`}
        >
          {card.label}
        </p>
        {card.parentId && (
          <FocalBreadcrumb card={card} ctx={ctx} />
        )}
        {/* Hops the data source attached to a level ABOVE the focus.
            Nothing above the focus is drawn, so there is no card for
            them to land on — but they are facts, and a partner sitting
            there with no wire on it needs the explanation. */}
        {focalStats && focalStats.coarser > 0 && (
          <p
            className="text-[9px] italic text-ink-muted/70 truncate"
            title={`${focalStats.coarser.toLocaleString()} connection${focalStats.coarser === 1 ? '' : 's'} the data source records against a level above ${card.label}. They are drawn nowhere: this picture never boxes the levels above the focus. Focus a breadcrumb above to see them.`}
          >
            +{focalStats.coarser.toLocaleString()} connect at a coarser grain
          </p>
        )}
        {focalStats && (
          <div className="flex items-center gap-2.5 mt-1 pt-1 border-t border-black/[0.07] dark:border-white/[0.08] text-[10.5px] font-medium tabular-nums">
            <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
              <LucideIcons.ArrowDownLeft className="w-3 h-3" />
              {focalStats.in} in
            </span>
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <LucideIcons.ArrowUpRight className="w-3 h-3" />
              {focalStats.out} out
            </span>
          </div>
        )}
        {/* How far the walk has reached — the question Focus mode gets
            opened to answer, counted off the model the board draws
            rather than measured separately. An open frontier makes
            these floors, and says so. */}
        {focalReach && (
          <p
            className="flex items-center gap-1 mt-0.5 text-[9px] text-ink-muted tabular-nums truncate"
            title={focalReach.moreUp || focalReach.moreDown
              ? 'Entities this walk has reached so far. A + marks a floor rather than a total — more exists that way. Use ⊕ on a card to walk further.'
              : 'Every entity connected to this one, upstream and downstream, as far as the data source goes.'}
          >
            <LucideIcons.Radar className="w-2.5 h-2.5 flex-shrink-0 text-accent-lineage/70" />
            <span className="truncate">
              Reach: {focalReach.up.toLocaleString()}{focalReach.moreUp ? '+' : ''} upstream
              {' · '}{focalReach.down.toLocaleString()}{focalReach.moreDown ? '+' : ''} downstream
            </span>
          </p>
        )}
      </div>
    )
  }

  // ── Inside a frame: ONE row language, whatever the row is ──
  if (card.frameId) return <FrameRow card={card} ctx={ctx} selected={selected} />

  // ── Entity: the rich neighbor card, at the top level of a band ──
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={keyActivate}
      onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
      title={`${card.label}${card.description ? ` — ${card.description}` : ''} · click to inspect, double-click to focus`}
      style={{ width: card.w, height: card.h, borderLeftWidth: 3, borderLeftColor: accent }}
      className={cn(
        'group relative flex items-center gap-2 rounded-lg border border-black/[0.07] dark:border-white/[0.08] px-2.5 cursor-pointer transition-colors bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] hover:border-accent-lineage/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        selected ? 'ring-2 ring-accent-lineage' : onPath && 'ring-1 ring-accent-lineage/70',
        dim,
      )}
    >
      {card.wired && <PortHandles />}
      <ContentsChevron card={card} ctx={ctx} />
      {(
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}1f` }}
        >
          <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 min-w-0 text-[12px] font-medium text-ink leading-snug">
          <span className="truncate">{card.label}</span>
        </p>
        <p className="flex items-center gap-1 text-[9.5px] text-ink-muted/70 leading-snug min-w-0">
          {(card.ancestry.length > 0 || card.parentLabel) && (
            <>
              <ProvenanceRibbon card={card} />
              <span className="text-ink-muted/40">·</span>
            </>
          )}
          {card.edgeTypeNorm && card.edgeTypeNorm !== card.frameSharedEdgeType && (
            <>
              <span
                className="w-1 h-1 rounded-full flex-shrink-0"
                style={{ backgroundColor: generateEdgeColorFromType(card.edgeTypeNorm) }}
              />
              <span
                className="truncate uppercase tracking-wide"
                title={ctx.edgeTypeInfo?.get(card.edgeTypeNorm)?.description}
              >
                {edgeLabelFor(card.edgeTypeNorm, ctx.edgeTypeInfo)}
              </span>
            </>
          )}
          {card.count > 1 && (
            <span
              className="tabular-nums font-semibold text-ink-muted flex-shrink-0"
              title={`${card.count.toLocaleString()} connections to this entity`}
            >
              ×{card.count.toLocaleString()}
            </span>
          )}
          {card.contents && (
            <>
              <span className="text-ink-muted/40">·</span>
              <ContentsCount card={card} />
            </>
          )}
        </p>
      </div>
      <CardActions card={card} ctx={ctx} />
      <WalkPills card={card} ctx={ctx} />
    </div>
  )
}

/**
 * Content-based memo boundary. The builder returns fresh card objects
 * on every rebuild, so a reference-equality memo never held and one
 * arriving fetch re-rendered the whole board. Comparing the card's
 * fields instead means only genuinely-changed cards re-render — and it
 * does so without caching anything across renders. This component
 * reads exactly `data` and `selected`; React Flow applies position
 * itself, so nothing else can affect the output.
 */
/**
 * A container opened into what's inside it that connects to the focal.
 * Rendered BEHIND its children (see zIndex where nodes are built), with
 * a header that stays interactive while the body lets clicks through to
 * the child cards sitting on top.
 */
function FocusFrameNode({ data }: NodeProps) {
  const { card, ctx } = data as unknown as { card: FocusCard; ctx: CardCtx }
  const { onPath, offPath } = usePathState(card.id)
  // A frame nested inside another frame is also one of ITS rows, so it
  // answers to the host's keyboard cursor like any other row does.
  const rowCursor = useContext(RowCursorContext)
  const hostKey = card.frameId ? card.parentId ?? '' : null
  const onCursor = hostKey !== null && rowCursor?.frameKey === hostKey && rowCursor.urn === card.nodeId
  // The Find box is asked for rather than always sitting there — see the
  // header, where 64px of permanent input clipped the honest counts.
  const [findOpen, setFindOpen] = useState(false)
  // The CONTAINS-STACK: the focus's own contents, not an entity of its
  // own (no urn, nowhere to re-center to, no wires). It is chrome, so it
  // borrows none of the focal's identity — wearing the focus's type
  // colour and icon made it read as a second copy of the focus.
  const isStack = card.nodeId === null
  const accent = isStack ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  // Whether anything will sit beside the name — see the name's width.
  const hasAncestryChip = card.frameId === null && (card.ancestry.length > 0 || card.parentLabel !== null)
  // The thing you asked about, when it happens to hold things. It reads
  // as the anchor — solid border, the accent glow the focal card has —
  // rather than as one more container that drifted into the picture.
  const q = ctx.frameQueryFor?.(card.expandKey ?? '') ?? ''
  // A total is a claim: state it only when the last page has landed (or
  // the container reported its own count). Otherwise say "at least".
  const win = frameWindow(card)
  const total = win.exact ? win.total.toLocaleString() : `${win.total.toLocaleString()}+`
  // Which rows are on screen. NOT in the header: between the chevron,
  // the name, the ancestry chip, the Connected|All pair, the Find box
  // and the focus control, that line has about 94px, and "6 on this
  // lineage · showing 1–10 of 60" truncated halfway through the first
  // half of it. It goes where a reader looks when scrolling instead —
  // at the foot of the list, beside the thumb (see `FrameScrollRegion`).
  const range = win.scrollable ? `${win.from.toLocaleString()}–${win.to.toLocaleString()} of ${total}` : null
  // In "everything inside" the search runs on the SERVER, so the counts
  // describe the matches, not the container — say which.
  const searching = card.frameShowingAll && q.trim().length > 0
  // Every row shares one relationship type → the frame says it once
  // instead of the rows each repeating it.
  const via = card.frameSharedEdgeType
    ? ` · ${edgeLabelFor(card.frameSharedEdgeType, ctx.edgeTypeInfo)}`
    : ''
  // Showing everything BECAUSE the lineage answer was empty — say so,
  // or the roster reads as an answer to a question nobody asked.
  const fellBack = card.frameShowingAll && card.frameEmpty && card.frameConnectedCount === 0
  const inside = card.frameShowingAll
    ? fellBack
      ? 'nothing here is on this lineage · showing everything inside'
      : `${card.frameConnectedCount.toLocaleString()} on this lineage · of ${total}${searching ? ` matching "${q.trim()}"` : ''}`
    : `${card.count.toLocaleString()} connected inside${via}`
  return (
    <div
      {...(hostKey !== null && card.nodeId
        ? { id: rowDomId(hostKey, card.nodeId), role: 'option' as const, 'aria-selected': false }
        : {})}
      style={{
        width: card.w,
        height: card.h,
        borderColor: `${accent}55`,
      }}
      className={cn(
        'relative rounded-xl border-2 border-dashed pointer-events-none bg-black/[0.02] dark:bg-white/[0.03]',
        onCursor ? 'ring-2 ring-accent-lineage/60' : onPath && 'ring-1 ring-accent-lineage/70',
        offPath && OFF_PATH_CARD,
      )}
    >
      {/* The stack is the focal's own contents, and no wire ever lands on
          it — its rows' lineage is drawn at the focal card above. */}
      {card.wired && <PortHandles />}
      {/* An open container keeps its own lineage question: looking
          inside something must never end the walk. */}
      <WalkPills card={card} ctx={ctx} />
      {/* Header — the only interactive part; the body is click-through
          so the child cards above stay reachable. */}
      <div className="pointer-events-auto absolute inset-x-0 top-0 h-[46px] px-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); ctx.onToggleFrame(card.expandKey!) }}
          aria-expanded={card.childrenOpen}
          aria-label={card.childrenOpen ? `Collapse ${card.label}` : `Expand ${card.label}`}
          title={card.childrenOpen ? `Collapse ${card.label}` : `Expand ${card.label}`}
          className="nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          {card.childrenOpen
            ? <LucideIcons.ChevronDown className="w-3.5 h-3.5" />
            : <LucideIcons.ChevronRight className="w-3.5 h-3.5" />}
        </button>
        {isStack
          ? <LucideIcons.Boxes className="w-3.5 h-3.5 flex-shrink-0" style={{ color: accent }} />
          : <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          {/* Name, then where it lives — the levels above it are text,
              never boxes, so the chip is how they are stated at all. */}
          <div className="flex items-baseline gap-1.5 min-w-0">
            {/* The NAME is the identity and takes what it needs first —
                sharing the shrink evenly turned `clean_charges` into
                `…n_charges`, which names nothing. The chip lives in
                what is left, and truncates there. With no chip beside
                it the name keeps the whole line: capping it anyway
                clipped `int_clean_products_t1` for no one's benefit. */}
            {/* The contains-stack is the FOCUS'S contents, so it says
                whose: "Inside fact_orders", never a bare "Contains" that
                names a box rather than a thing. */}
            {isStack && <span className="flex-shrink-0 text-[9.5px] text-ink-muted/70">Inside</span>}
            <TailName className={cn(
              'block text-[11.5px] font-semibold text-ink leading-tight',
              hasAncestryChip && 'max-w-[62%] flex-shrink-0',
            )}>
              {card.label}
            </TailName>
            <FrameAncestry card={card} ctx={ctx} />
          </div>
          <p
            className="flex items-center gap-1 text-[9px] text-ink-muted/80 leading-tight truncate"
            title={range ? `Rows ${range} — scroll inside ${card.label} to read the rest` : undefined}
          >
            {card.fetch === 'loading'
              ? 'Looking inside…'
              // When the roster is standing in for an empty lineage
              // answer, WHY these rows are here outranks counting them —
              // otherwise a full list of columns under "0 on this
              // lineage" reads as the answer to a question nobody asked.
              : card.contents && !fellBack
                // Both numbers, exactly: what is in here on this
                // lineage, and what is in here altogether.
                ? <ContentsCount card={card} />
                : <span className="truncate">{inside}</span>}
          </p>
        </div>
        {/* Connected ⇄ All. The default answers "what in here is on this
            lineage"; All answers "what else is in here", with lineage
            still marked wherever it exists.
            The walk model IS the roster for what connects — but only the
            children endpoint knows what ELSE is in there, so this is the
            one control on a frame that can cost a fetch. */}
        {ctx.onToggleFrameAll && (
          <div
            role="group"
            aria-label={`What to show inside ${card.label}`}
            className="nodrag flex-shrink-0 flex items-center rounded-md border border-black/10 dark:border-white/10 p-0.5"
          >
            {([
              { all: false, Icon: LucideIcons.Link2, label: 'Only what is on this lineage' },
              { all: true, Icon: LucideIcons.Rows3, label: 'Everything inside, lineage marked' },
            ] as const).map(({ all, Icon, label }) => (
              <button
                key={String(all)}
                type="button"
                disabled={card.fetch === 'loading'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (all !== card.frameShowingAll) ctx.onToggleFrameAll?.(card.expandKey ?? '')
                }}
                title={card.fetch === 'loading' ? 'Looking inside…' : label}
                aria-label={label}
                aria-pressed={card.frameShowingAll === all}
                className={cn(
                  'p-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  card.frameShowingAll === all
                    ? 'bg-accent-lineage/12 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="w-3 h-3" />
              </button>
            ))}
          </div>
        )}
        {/* Find one by name without reading everything — offered only
            when there IS more than one screenful, because reserving the
            room truncated the frame's own name on every frame.
            Collapsed to its icon until asked for: a permanent 64px box
            left this header's count line about 94px, which clipped
            "6 on this lineage · of 60" halfway through. */}
        {(win.scrollable || card.frameShowingAll) && (
          findOpen || q !== '' ? (
            <input
              autoFocus
              value={q}
              onChange={(e) => ctx.onFrameQuery(card.expandKey ?? '', e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setFindOpen(false)}
              placeholder="Find…"
              aria-label={card.frameShowingAll ? `Search inside ${card.label}` : `Filter what is inside ${card.label}`}
              title={card.frameShowingAll
                ? `Search every entity inside ${card.label}, not only the rows on screen`
                : 'Filter what is inside'}
              className="nodrag flex-shrink-0 w-16 px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.06] border border-black/10 dark:border-white/10 text-[10px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/60"
            />
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setFindOpen(true) }}
              aria-label={card.frameShowingAll ? `Search inside ${card.label}` : `Filter what is inside ${card.label}`}
              title={card.frameShowingAll
                ? `Search every entity inside ${card.label}, not only the rows on screen`
                : 'Filter what is inside'}
              className="nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <LucideIcons.Search className="w-3 h-3" />
            </button>
          )
        )}
        {/* The contains-stack is the focus's own contents — there is
            nowhere to re-center TO, and the focal card is already the
            centre. Only a frame that IS an entity offers this. */}
        {card.nodeId && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onFocus(card.nodeId!) }}
            title={`Focus ${card.label}`}
            className="nodrag flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            <LucideIcons.Focus className="w-3 h-3" />
          </button>
        )}
      </div>

      {card.fetch === 'loading' && (
        <div className="absolute inset-x-2.5 top-[52px] space-y-1.5">
          {[0, 1].map(i => (
            <div key={i} className="h-8 rounded-lg bg-black/[0.05] dark:bg-white/[0.06] animate-pulse" />
          ))}
        </div>
      )}
      {card.fetch === 'error' && (
        <div className="pointer-events-auto absolute inset-x-2.5 top-[52px] flex items-center gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">Couldn&apos;t look inside.</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.onRetryFrameAll?.(card.expandKey ?? '') }}
            className="nodrag font-semibold hover:underline"
          >
            Retry
          </button>
        </div>
      )}
      {card.frameEmpty && card.frameLoaded === 0 && card.fetch === null && (
        <p className="absolute inset-x-2.5 top-[52px] text-[10px] text-ink-muted/70 italic leading-snug">
          Nothing inside {card.label} is on this lineage.
          {ctx.onToggleFrameAll && ' Show everything inside to see what it holds.'}
        </p>
      )}
      {card.childrenOpen && (
        <FrameScrollRegion card={card} ctx={ctx} win={win} />
      )}
    </div>
  )
}

/**
 * The frame's BODY as a browsable list: a wheel scrolls it, a keyboard
 * walks it, and a thumb on its right edge says where in the list you are.
 *
 * It is a region rather than a real scroll container because the rows are
 * React Flow nodes, not DOM children of the frame — that is what lets a
 * wire land on one row of a 400-column table. So the window moves by
 * WHOLE ROWS: a row is either fully drawn inside its frame or not drawn
 * at all, which is exactly the clipping a native scroller would give and
 * is the one thing an overflow-less absolute layout cannot fake.
 *
 * It sits UNDER the rows (see zIndex where nodes are built), so it is the
 * wheel target only in the frame's own margins; the rows forward theirs.
 */
function FrameScrollRegion({ card, ctx, win }: {
  card: FocusCard
  ctx: CardCtx
  win: ReturnType<typeof frameWindow>
}) {
  const key = card.expandKey ?? ''
  const cursor = useContext(RowCursorContext)
  const rows = card.frameRows
  const cursorIndex = cursor?.frameKey === key
    ? rows.findIndex(r => r.urn === cursor.urn)
    : -1
  // Type-ahead buffer: consecutive letters compose one search, a pause
  // starts a new one. Held in a ref because it is not visible state —
  // re-rendering the frame per keystroke would be a rebuild for nothing.
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 })

  const scrollTo = (offset: number) =>
    ctx.onFrameScroll(key, Math.max(0, Math.min(offset, win.maxOffset)))

  /** Put the cursor on row `i`, bringing the window to it. */
  const moveCursor = (i: number) => {
    const next = Math.max(0, Math.min(i, rows.length - 1))
    const row = rows[next]
    if (!row) return
    ctx.onRowCursor(key, row.urn)
    if (next < win.offset) scrollTo(next)
    else if (next >= win.offset + win.size) scrollTo(next - win.size + 1)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = cursorIndex
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      moveCursor(at < 0 ? win.offset : at + (e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      moveCursor(e.key === 'Home' ? 0 : rows.length - 1)
      return
    }
    if (e.key === 'Enter' && at >= 0) {
      e.preventDefault()
      e.stopPropagation()
      // Shift is the second gesture the mouse spells double-click:
      // Enter previews, Shift+Enter commits to walking there.
      if (e.shiftKey) ctx.onFocus(rows[at].urn)
      else ctx.onSelect(rows[at].urn)
      return
    }
    if (e.key === 'ArrowRight' && at >= 0 && rows[at].canOpen) {
      e.preventDefault()
      e.stopPropagation()
      ctx.onToggleFrame(rows[at].urn)
      return
    }
    if (e.key === 'ArrowLeft') {
      // Step OUT of the rows: drop the preview and park the cursor. The
      // list keeps focus, so Down starts again from the top rather than
      // stranding a keyboard reader with nothing focused at all.
      // (Escape is the LENS's key, in one place — see its own handler.)
      e.preventDefault()
      e.stopPropagation()
      ctx.onSelect(null)
      ctx.onRowCursor(key, null)
      return
    }
    // Type-ahead — the way anyone finds `posted_at` in a 400-column
    // table without reaching for the mouse. Client-side over the rows in
    // hand; a miss hands the letters to the frame's own Find, which asks
    // the server about the rows that have NOT loaded — but only where
    // that box is actually offered, or the letters would dim every row
    // of a short list against a query with nowhere to be seen or cleared.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      e.stopPropagation()
      const now = Date.now()
      const text = (now - typed.current.at < 800 ? typed.current.text : '') + e.key.toLowerCase()
      typed.current = { text, at: now }
      const from = at < 0 ? 0 : at + (text.length === 1 ? 1 : 0)
      const order = [...rows.slice(from), ...rows.slice(0, from)]
      const hit = order.find(r => r.label.toLowerCase().startsWith(text))
        ?? order.find(r => r.label.toLowerCase().includes(text))
      if (hit) moveCursor(rows.findIndex(r => r.urn === hit.urn))
      else if (win.scrollable || card.frameShowingAll) ctx.onFrameQuery(key, text)
    }
  }

  return (
    <>
      <div
        // `nowheel` is what stops React Flow zooming the board out from
        // under a scroll; `nodrag` stops a scroll-drag panning it.
        className="nowheel nodrag pointer-events-auto absolute inset-x-0 bottom-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded-b-xl"
        style={{ top: FRAME_HEADER_H }}
        // The single tab stop for the whole list: Tab must not have to
        // walk 400 columns to get past a table. Inside it, the arrow
        // keys move a cursor named by `aria-activedescendant` — the rows
        // are owned rather than contained, because React Flow renders
        // them as the frame's siblings (see `rowDomId`).
        role="listbox"
        tabIndex={0}
        aria-label={`Rows inside ${card.label}. Up and down to move, Enter to preview, Shift+Enter to focus, right arrow to open, Escape to leave.`}
        aria-activedescendant={cursorIndex >= 0 ? rowDomId(key, rows[cursorIndex].urn) : undefined}
        // Only the rows actually DRAWN: an owned id that names nothing
        // is a broken relationship, not a generous one.
        aria-owns={rows.slice(win.offset, win.offset + win.size).map(r => rowDomId(key, r.urn)).join(' ') || undefined}
        onKeyDown={onKeyDown}
        onWheel={(e) => { e.stopPropagation(); ctx.onFrameWheel(key, e.deltaY) }}
        onFocus={() => { if (cursorIndex < 0 && rows.length > 0) ctx.onRowCursor(key, rows[win.offset]?.urn ?? rows[0].urn) }}
        // The cursor is a FOCUS affordance: a ring left behind on a list
        // nobody is in points at nothing.
        onBlur={() => ctx.onRowCursor(key, null)}
      />
      {/* Where in the list you are, both ways: a draggable thumb (so a
          400-row table is one gesture from end to end) and the numbers
          under it. At the FOOT of the list rather than in the header,
          which has ~94px between the name and the Find box and clipped
          "6 on this lineage · showing 1–10 of 60" halfway through. */}
      {win.scrollable && (
        <>
          <FrameScrollThumb card={card} win={win} onScroll={scrollTo} />
          <span
            className="pointer-events-none absolute bottom-[2px] right-2.5 text-[9px] tabular-nums text-ink-muted/75 leading-none"
            title={`Rows ${win.from.toLocaleString()}–${win.to.toLocaleString()} of ${
              win.exact ? win.total.toLocaleString() : `${win.total.toLocaleString()}+`
            } inside ${card.label}`}
          >
            {win.from.toLocaleString()}–{win.to.toLocaleString()} of{' '}
            {win.exact ? win.total.toLocaleString() : `${win.total.toLocaleString()}+`}
          </span>
        </>
      )}
      {/* The next page, on its way in. A shimmer where the rows will be
          is the honest statement: they are coming, and this is how many. */}
      {card.fetch === 'loading' && win.atEnd && (
        <div className="absolute inset-x-2.5 bottom-2 h-6 rounded-lg bg-black/[0.05] dark:bg-white/[0.06] animate-pulse" />
      )}
    </>
  )
}

/** The scroll thumb: size says how much of the list is on screen,
 *  position says where. Dragging it moves the window. */
function FrameScrollThumb({ card, win, onScroll }: {
  card: FocusCard
  win: ReturnType<typeof frameWindow>
  onScroll: (offset: number) => void
}) {
  const trackH = Math.max(0, card.h - FRAME_HEADER_H - FRAME_PAD * 2)
  const span = Math.max(1, win.loaded)
  const thumbH = Math.max(18, Math.round(trackH * Math.min(1, win.size / span)))
  const travel = Math.max(0, trackH - thumbH)
  const thumbY = win.maxOffset === 0 ? 0 : Math.round(travel * (win.offset / win.maxOffset))
  return (
    <div
      className="nodrag pointer-events-auto absolute w-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07]"
      style={{ top: FRAME_HEADER_H + FRAME_PAD, right: 3, height: trackH }}
      aria-hidden
      onPointerDown={(e) => {
        e.stopPropagation()
        const track = e.currentTarget
        const rect = track.getBoundingClientRect()
        const move = (ev: PointerEvent) => {
          const t = travel === 0 ? 0 : (ev.clientY - rect.top - thumbH / 2) / travel
          onScroll(Math.round(Math.max(0, Math.min(1, t)) * win.maxOffset))
        }
        move(e.nativeEvent)
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    >
      <div
        className="absolute inset-x-0 rounded-full bg-black/25 dark:bg-white/30"
        style={{ top: thumbY, height: thumbH }}
      />
    </div>
  )
}

const MemoFocusFrameNode = memo(FocusFrameNode, (prev, next) => {
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx }
  return a.ctx === b.ctx && sameCard(a.card, b.card)
})

const MemoFocusGraphCard = memo(FocusGraphCard, (prev, next) => {
  if (prev.selected !== next.selected) return false
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { in: number; out: number; coarser: number } }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { in: number; out: number; coarser: number } }
  return a.ctx === b.ctx
    && a.focalStats?.in === b.focalStats?.in
    && a.focalStats?.out === b.focalStats?.out
    && a.focalStats?.coarser === b.focalStats?.coarser
    && sameCard(a.card, b.card)
})

// ── Band labels ──────────────────────────────────────────────────────

/** Non-interactive header floating above each hop band ("Data Sources
 *  · 30 of 45"), or an italic whisper for an empty direction. */
function BandLabelNode({ data }: NodeProps) {
  const d = data as unknown as { band?: number; sub?: string; whisper?: string }
  if (d.whisper) {
    return (
      <div style={{ width: CARD_W }} className="pointer-events-none text-[10.5px] italic text-ink-muted/60 leading-snug">
        {d.whisper}
      </div>
    )
  }
  const band = d.band ?? 1
  const isUp = band < 0
  const hop = Math.abs(band)
  return (
    <div style={{ width: CARD_W }} className="pointer-events-none flex items-baseline gap-1.5 whitespace-nowrap">
      {isUp
        ? <LucideIcons.ArrowDownLeft className="w-3 h-3 self-center text-sky-500" />
        : <LucideIcons.ArrowUpRight className="w-3 h-3 self-center text-amber-500" />}
      <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink-muted/70">
        {isUp
          ? hop === 1 ? 'Data Sources' : `Sources · hop ${hop}`
          : hop === 1 ? 'Data Consumers' : `Consumers · hop ${hop}`}
      </span>
      {d.sub && <span className="text-[9px] tabular-nums text-ink-muted/50">{d.sub}</span>}
    </div>
  )
}

const MemoFrameDividerNode = memo(FrameDividerNode, (prev, next) => {
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx }
  return a.ctx === b.ctx && sameCard(a.card, b.card)
})

const NODE_TYPES = {
  focusCard: MemoFocusGraphCard,
  focusFrame: MemoFocusFrameNode,
  focusDivider: MemoFrameDividerNode,
  bandLabel: BandLabelNode,
}

// ── Edge ─────────────────────────────────────────────────────────────

function FocusGraphEdgeComp({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const d = data as unknown as {
    count: number
    aggregated: boolean
    containment: boolean
    dimmed: boolean
    tint: string
    cycleBack?: boolean
    reducedMotion?: boolean
    /** The layout says this bundle's badge has something to say and room
     *  to say it (see `FocusEdge.labelVisible`). */
    labelVisible?: boolean
    /** Too many badges on this board for all of them to be read. */
    labelDense?: boolean
  }
  // Hover emphasis is derived here from context: the edges ARRAY stays
  // identity-stable, so sweeping the pointer never rebuilds it (nor
  // makes React Flow reconcile every edge).
  const hoveredId = useContext(HoverContext)
  const emphasized = hoveredId != null && (source === hoveredId || target === hoveredId)
  // Path-to-focus highlight — same context-routing reason as above.
  const pathHighlight = useContext(PathHighlightContext)
  const onPath = pathHighlight != null && pathHighlight.edgeKeys.has(id)
  const offPath = pathHighlight != null && !onPath && pathHighlight.source === 'select'
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const strong = emphasized || onPath
  // Highlighting STRENGTHENS what it points at; it does not wash out
  // everything else. Hovering used to push every other wire to 20% and
  // a path highlight to 12%, which turned reading one connection into
  // losing the picture around it. Only a deliberate SELECTION quiets the
  // rest now, and only to a floor that stays legible.
  const opacity = d.dimmed ? 0.12
    : strong ? 1
      : offPath ? OFF_PATH_EDGE
        : d.containment ? 0.45 : 0.7
  // A ×N survives density only where the reader is actually looking. A
  // CYCLE badge is not a count and is never suppressed: "this lineage
  // loops back" is a fact about the data, and two wires between one pair
  // read as a duplicate without it.
  const showCount = (d.labelVisible ?? false) && !d.dimmed && (!d.labelDense || strong)
  const showCycle = (d.cycleBack ?? false) && !d.dimmed
  const showLabel = showCount || showCycle
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: d.tint,
          strokeWidth: strong ? (d.aggregated ? 3 : 2.5) : d.aggregated ? 2 : 1.5,
          strokeDasharray: d.containment ? '4 4' : undefined,
          opacity,
          transition: d.reducedMotion ? undefined : 'opacity 120ms, stroke-width 120ms',
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: offPath ? OFF_PATH_EDGE : 1 }}
            className={cn(
              'absolute pointer-events-none px-1 py-px rounded-full bg-canvas-elevated border border-black/10 dark:border-white/10 text-[8.5px] font-semibold tabular-nums text-ink-muted shadow-sm',
              // Only a cycle badge needs to sit beside a count; a bare
              // count keeps exactly the box it has always had.
              showCycle && 'flex items-center gap-0.5',
            )}
          >
            {/* This hop runs back towards the focus rather than away
                from it: the lineage loops. Said out loud, because two
                wires between the same pair otherwise read as a
                duplicate rather than a cycle. */}
            {showCycle && (
              <LucideIcons.RefreshCcw
                className="w-2 h-2 text-amber-600 dark:text-amber-400"
                aria-label="This connection loops back"
              />
            )}
            {showCount && `×${d.count.toLocaleString()}`}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const EDGE_TYPES = { focusEdge: FocusGraphEdgeComp }

// ── Peek ─────────────────────────────────────────────────────────────

/** The panel's own box, in screen px. Fixed because it is chrome rather
 *  than board geometry: it must stay readable at 0.25× zoom, so it is
 *  positioned rather than scaled — which means the docking maths needs
 *  its size up front. `PEEK_MAX_H` is a generous ceiling used only to
 *  keep it inside the pane. */
const PEEK_W = 236
const PEEK_MAX_H = 280

/**
 * The PEEK — one click on a row, and what that row IS, beside it.
 *
 * It replaces the hover toolbar rows used to carry. That toolbar
 * appeared exactly where the pointer was on its way to the ⊕ beside it,
 * and half its area was padding with no handler behind it: the reported
 * "the + needs three clicks". A click now has one meaning on a row —
 * show me this — and the actions live in a panel that is not in the way
 * of anything.
 *
 * Positioned in SCREEN space beside the row, from the board's own
 * transform, so it never scales with zoom (a 10px panel at 0.25× is not
 * a panel) and never has to be laid out by the builder. Subscribing to
 * the transform HERE, rather than lifting it into the view, is what
 * keeps a pan re-rendering this panel alone.
 */
function LensPeek({ card, host, ctx, onDismiss }: {
  card: FocusCard
  /** The frame the row sits in, when it sits in one — the panel docks to
   *  the frame's edge so it never covers the rows either side. */
  host: FocusCard | null
  ctx: CardCtx
  onDismiss: () => void
}) {
  const [tx, ty, zoom] = useStore(s => s.transform)
  const paneW = useStore(s => s.width)
  const paneH = useStore(s => s.height)
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  const anchor = host ?? card
  // AWAY from the focus. An upstream frame has the focal card sitting
  // immediately to its right — docking there covered the entity the
  // whole picture is about with a panel about one of its columns.
  // Flipped back only when the preferred side would leave the pane.
  const left = anchor.x * zoom + tx - PEEK_W - 10
  const right = (anchor.x + anchor.w) * zoom + tx + 10
  const preferLeft = card.band < 0
  const fits = (v: number) => v >= 8 && v + PEEK_W <= paneW - 8
  const wanted = preferLeft ? left : right
  const other = preferLeft ? right : left
  const x = fits(wanted) ? wanted : fits(other) ? other : Math.max(8, Math.min(wanted, paneW - PEEK_W - 8))
  // Vertically centred on the row, but never hanging off the top or
  // bottom of the pane — a panel you have to pan to read is not a peek.
  const half = PEEK_MAX_H / 2
  const rowY = (card.y + card.h / 2) * zoom + ty
  const y = paneH > PEEK_MAX_H + 16
    ? Math.max(half + 8, Math.min(rowY, paneH - half - 8))
    : rowY
  const flows = card.flowsIn + card.flowsOut
  const pill = card.band < 0 ? card.pillUp ?? card.pillDown : card.pillDown ?? card.pillUp
  const pillDir: 'in' | 'out' = pill != null && pill === card.pillUp ? 'in' : 'out'
  const act = 'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

  return (
    <div
      role="dialog"
      aria-label={`Preview of ${card.label}`}
      className="nowheel nodrag absolute z-50 -translate-y-1/2 rounded-xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-xl shadow-black/20 p-2.5"
      style={{ left: x, top: y, width: PEEK_W }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-1.5">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}1f` }}
        >
          <TypeIcon ctx={ctx} typeId={card.type} color={accent} className="w-3.5 h-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-ink leading-tight break-words">{card.label}</p>
          <p className="text-[9px] font-bold uppercase tracking-[0.1em] truncate" style={{ color: accent }}>
            {card.type}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close preview"
          className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          <LucideIcons.X className="w-3 h-3" />
        </button>
      </div>
      {/* Where it lives — the same crumb the board draws, so the panel
          never disagrees with the picture it is sitting on. */}
      {(card.ancestry.length > 0 || card.parentLabel) && (
        <p className="mt-1.5 flex items-center gap-1 min-w-0 text-[9.5px] text-ink-muted" title={`in ${card.ancestry.join(' › ')}`}>
          <LucideIcons.CornerLeftUp className="w-2.5 h-2.5 flex-shrink-0" />
          <span className="truncate">
            in {card.ancestry.length > 0 ? card.ancestry.join(' › ') : card.parentLabel}
          </span>
        </p>
      )}
      {card.description && (
        <p className="mt-1.5 text-[10px] text-ink-secondary leading-snug line-clamp-3">{card.description}</p>
      )}
      {/* What the walk knows about it, in words rather than a badge —
          and a floor is marked as a floor, never rounded into a total. */}
      <div className="mt-2 pt-1.5 border-t border-black/[0.07] dark:border-white/[0.08] space-y-0.5 text-[10px] tabular-nums">
        <p className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
            <LucideIcons.ArrowDownLeft className="w-3 h-3" />
            {card.flowsIn.toLocaleString()} in
          </span>
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <LucideIcons.ArrowUpRight className="w-3 h-3" />
            {card.flowsOut.toLocaleString()} out
          </span>
          <span className="text-ink-muted/70">
            {flows === 0 ? 'no lineage here' : `${flows.toLocaleString()} flow${flows === 1 ? '' : 's'} in this walk`}
          </span>
        </p>
        {pill?.count != null && pill.count > 0 && (
          <p className="text-ink-muted/70">
            {pill.count.toLocaleString()} more {pillDir === 'in' ? 'upstream' : 'downstream'} not fetched yet
          </p>
        )}
        {card.contents && (
          <p className="text-ink-muted/70">
            <ContentsCount card={card} />
          </p>
        )}
        {card.freshness && timeAgo(card.freshness) && (
          <p className="flex items-center gap-1 text-ink-muted/70">
            <LucideIcons.Clock className="w-2.5 h-2.5 flex-shrink-0" />
            Last synced {timeAgo(card.freshness)}
          </p>
        )}
      </div>
      <div className="mt-2 space-y-1">
        {/* Only the moves this row can actually make. A "walk from here"
            over a drained direction would be a button that does nothing,
            which is the whole complaint the ⊕ states honestly. */}
        {pill && ctx.onExtend && ctx.onRevealMore && (
          <button
            type="button"
            onClick={() => {
              onDismiss()
              if (pill.kind === 'reveal') ctx.onRevealMore?.(pill.key)
              else if (pill.kind === 'page' && pill.cursor) ctx.onPage?.(pillTarget(pill.key), pillDir, pill.cursor)
              else ctx.onExtend?.(pill.key, pillTarget(pill.key), pillDir)
            }}
            className={cn(act, 'bg-accent-lineage/12 border border-accent-lineage/35 text-accent-lineage hover:bg-accent-lineage/20')}
          >
            <LucideIcons.Plus className="w-3 h-3" />
            Walk further {pillDir === 'in' ? 'upstream' : 'downstream'}
            {pill.count != null && <span className="ml-auto tabular-nums opacity-70">{pill.count.toLocaleString()}</span>}
          </button>
        )}
        {card.nodeId && (
          <button
            type="button"
            onClick={() => ctx.onFocus(card.nodeId!)}
            className={cn(act, 'border border-black/10 dark:border-white/10 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}
          >
            <LucideIcons.Focus className="w-3 h-3" />
            Focus here
          </button>
        )}
        {card.canOpenChildren && card.expandKey && (
          <button
            type="button"
            onClick={() => { onDismiss(); ctx.onToggleFrame(card.expandKey!) }}
            className={cn(act, 'border border-black/10 dark:border-white/10 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}
          >
            <LucideIcons.ChevronRight className="w-3 h-3" />
            {card.childrenOpen ? 'Close what is inside' : 'Open what is inside'}
          </button>
        )}
        {(ctx.onRevealOnCanvas || ctx.onOpenDetails) && card.nodeId && (
          <div className="flex items-center gap-1 pt-0.5">
            {ctx.onRevealOnCanvas && (
              <button
                type="button"
                onClick={() => void ctx.onRevealOnCanvas?.(card.nodeId!)}
                title="Reveal on canvas"
                className={cn(act, 'justify-center text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}
              >
                <LucideIcons.Crosshair className="w-3 h-3" />
                Canvas
              </button>
            )}
            {ctx.onOpenDetails && (
              <button
                type="button"
                onClick={() => ctx.onOpenDetails?.(card.nodeId!)}
                title="Open details"
                className={cn(act, 'justify-center text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}
              >
                <LucideIcons.PanelRight className="w-3 h-3" />
                Details
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────

/** Hand the browser a Blob to save, then release the object URL. No
 *  server call — the data is already sitting in `graph`. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** House-styled zoom cluster (React Flow's default chrome doesn't
 *  match the lens). Must render inside <ReactFlow> for useReactFlow. */
function GraphControls({ reducedMotion, exportName, graph, focalUrn, onResetLayout }: {
  reducedMotion: boolean
  exportName?: string
  /** The VISIBLE picture and who it's about — source for the data export. */
  graph: FocusGraph
  focalUrn: string
  /** Present only once something has been dragged. */
  onResetLayout?: () => void
}) {
  const rf = useReactFlow()
  const [exporting, setExporting] = useState(false)
  const dur = reducedMotion ? 0 : 200
  const btn = 'w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
  const fileStem = `lineage-${(exportName ?? 'focus').replace(/[^\p{L}\p{N}_-]+/gu, '-')}`

  const exportJson = () => {
    const payload = buildWalkExport(graph, focalUrn)
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${fileStem}.json`)
  }
  const exportCsv = () => {
    const payload = buildWalkExport(graph, focalUrn)
    downloadBlob(new Blob([walkExportToCsv(payload)], { type: 'text/csv' }), `${fileStem}.csv`)
  }

  // PNG export: re-project the whole graph into a fixed frame and
  // rasterize the viewport pane (the standard React Flow recipe).
  // The rasterizer is imported LAZILY — it is only needed when someone
  // actually exports, it keeps ~30KB out of the initial chunk, and a
  // missing/not-yet-installed module degrades to "this one button
  // doesn't work" instead of taking the whole lens down.
  const exportPng = async (e: React.MouseEvent) => {
    const viewport = (e.currentTarget as HTMLElement)
      .closest('.react-flow')
      ?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewport || exporting) return
    setExporting(true)
    try {
      const { toPng } = await import('html-to-image')
      // Frame children are positioned RELATIVE to their frame, so
      // feeding them to getNodesBounds would drag the box toward the
      // origin. They always sit inside their frame's rect anyway, so
      // the frames already account for them.
      const bounds = getNodesBounds(rf.getNodes().filter(n => !n.parentId))
      const width = Math.min(Math.ceil(bounds.width) + 160, 3200)
      const height = Math.min(Math.ceil(bounds.height) + 160, 2400)
      const vp = getViewportForBounds(bounds, width, height, 0.25, 2, 0.08)
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-elevated').trim() || '#ffffff'
      const dataUrl = await toPng(viewport, {
        backgroundColor: bg,
        width,
        height,
        pixelRatio: 2,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
        },
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `lineage-${(exportName ?? 'focus').replace(/[^\p{L}\p{N}_-]+/gu, '-')}.png`
      a.click()
    } catch {
      // Rasterization can fail on exotic content (e.g. blocked images);
      // the graph itself is unaffected — just release the button.
    } finally {
      setExporting(false)
    }
  }

  return (
    // `nopan`: React Flow stamps it on every draggable NODE itself, so
    // controls inside a card are covered — a Panel is not a node, and
    // without it a press on Zoom that drifts a pixel pans the board.
    <Panel position="bottom-right" className="!m-3 nopan">
      <div className="flex flex-col rounded-lg border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-md overflow-hidden divide-y divide-black/[0.06] dark:divide-white/[0.06]">
        <button type="button" title="Zoom in" onClick={() => void rf.zoomIn({ duration: dur })} className={btn}>
          <LucideIcons.Plus className="w-3.5 h-3.5" />
        </button>
        <button type="button" title="Zoom out" onClick={() => void rf.zoomOut({ duration: dur })} className={btn}>
          <LucideIcons.Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Fit the lineage in view"
          onClick={() => void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })}
          className={btn}
        >
          <LucideIcons.Maximize2 className="w-3.5 h-3.5" />
        </button>
        {/* Only offered once there is an arrangement to undo. */}
        {onResetLayout && (
          <button
            type="button"
            title="Tidy up — put every card back where the lens placed it"
            aria-label="Reset layout"
            onClick={() => {
              onResetLayout()
              window.setTimeout(
                () => void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM }),
                reducedMotion ? 0 : 60,
              )
            }}
            className={cn(btn, 'text-accent-lineage hover:text-accent-lineage')}
          >
            <LucideIcons.LayoutGrid className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Download this lineage as an image (for decks and docs)"
          onClick={(e) => void exportPng(e)}
          className={btn}
          disabled={exporting}
        >
          {exporting
            ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin text-accent-lineage/70" />
            : <LucideIcons.ImageDown className="w-3.5 h-3.5" />}
        </button>
        {/* Data export — the same VISIBLE picture as portable data, no
            server call. Two entries rather than a menu: one click,
            one file, same as the PNG button beside them. */}
        <button
          type="button"
          title="Export this lineage as JSON (for scripts and other tools)"
          aria-label="Export lineage data as JSON"
          onClick={exportJson}
          className={btn}
        >
          <LucideIcons.FileJson className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Export this lineage as CSV (for spreadsheets)"
          aria-label="Export lineage data as CSV"
          onClick={exportCsv}
          className={btn}
        >
          <LucideIcons.FileSpreadsheet className="w-3.5 h-3.5" />
        </button>
      </div>
    </Panel>
  )
}


// ── View ─────────────────────────────────────────────────────────────

export function FocusGraphView({
  graph,
  focalId,
  focalStats,
  focalFetch,
  focalReach,
  exportName,
  directionFilter = 'both',
  selectedId,
  reducedMotion,
  edgeTypeInfo,
  onSelect,
  onFocus,
  onToggleFrame,
  onFrameScroll,
  onFrameQuery,
  frameQueryFor,
  onToggleFrameAll,
  onRetryFrameAll,
  onRevealOnCanvas,
  onOpenDetails,
  onRevealMore,
  onExtend,
  onPage,
}: FocusGraphViewProps) {
  // Type visuals resolved ONCE per schema for the whole graph. Cards
  // used to each subscribe to the schema store and linear-scan the
  // entity-type list, so every card paid for every schema touch; now
  // it's a single O(1) lookup built eagerly here.
  const schema = useSchemaStore((s) => s.schema)
  const visualFor = useMemo(() => {
    const known = new Map<string, { color: string; Icon: LucideIcons.LucideIcon }>()
    for (const et of schema?.entityTypes ?? []) {
      // `visual` is absent for types an ontology hasn't styled — those
      // fall through to the deterministic generator below rather than
      // taking the graph down.
      if (et?.visual) known.set(et.id, { color: et.visual.color, Icon: iconByName(et.visual.icon) })
    }
    return (typeId: string) => {
      const key = typeId === 'not loaded' ? 'entity' : typeId
      const hit = known.get(key)
      if (hit) return hit
      // Type the ontology doesn't define — deterministic fallback.
      const v = getEntityVisual(schema ? { schema } : null, key)
      return { color: v.color, Icon: iconByName(v.icon) }
    }
  }, [schema])

  // Where the keyboard is inside a frame. Ephemeral view state — a
  // cursor is not part of the exploration a share link replays — and it
  // reaches the rows by CONTEXT, so arrowing down a 400-row table
  // re-renders the two rows whose ring changed, not the board.
  const [rowCursor, setRowCursor] = useState<{ frameKey: string; urn: string } | null>(null)
  const onRowCursor = useCallback((frameKey: string, urn: string | null) => {
    setRowCursor(urn === null ? null : { frameKey, urn })
  }, [])

  /**
   * A wheel over a frame, resolved to whole rows.
   *
   * Rows are React Flow nodes, so a frame cannot be a real scroll
   * container (see `FrameScrollRegion`) — this is the substitute, and it
   * is where the CLAMP lives, because banking an offset the frame cannot
   * reach makes the next scroll-back do nothing at all. The remainder
   * carries over between events so a trackpad's 3px-per-frame stream
   * moves the list at the same rate a mouse notch does.
   */
  const wheelDebt = useRef(new Map<string, number>())
  const cardByKey = useMemo(() => {
    const m = new Map<string, FocusCard>()
    for (const c of graph.cards) if (c.kind === 'frame' && c.expandKey) m.set(c.expandKey, c)
    return m
  }, [graph.cards])
  const onFrameWheel = useCallback((key: string, deltaPx: number) => {
    const card = cardByKey.get(key)
    if (!card) return
    const win = frameWindow(card)
    if (win.maxOffset === 0) return
    const debt = (wheelDebt.current.get(key) ?? 0) + deltaPx
    const rows = Math.trunc(debt / WHEEL_PX_PER_ROW)
    wheelDebt.current.set(key, debt - rows * WHEEL_PX_PER_ROW)
    if (rows === 0) return
    const next = Math.max(0, Math.min(win.offset + rows, win.maxOffset))
    if (next !== win.offset) onFrameScroll(key, next)
  }, [cardByKey, onFrameScroll])

  const ctx = useMemo<CardCtx>(() => ({
    edgeTypeInfo,
    focalId,
    visualFor,
    onSelect,
    onFocus,
    onToggleFrame,
    onFrameScroll,
    onFrameWheel,
    onFrameQuery,
    frameQueryFor,
    onToggleFrameAll,
    onRetryFrameAll,
    onRevealOnCanvas,
    onOpenDetails,
    onRowCursor,
    onRevealMore,
    onExtend,
    onPage,
  }), [edgeTypeInfo, focalId, visualFor, onSelect, onFocus, onToggleFrame, onFrameScroll, onFrameWheel, onFrameQuery, frameQueryFor, onToggleFrameAll, onRetryFrameAll, onRevealOnCanvas, onOpenDetails, onRowCursor, onRevealMore, onExtend, onPage])

  const focalIn = focalStats.in
  const focalOut = focalStats.out


  const baseNodes = useMemo((): Node[] => {
    const minYByBand = new Map<number, number>()
    for (const c of graph.cards) {
      const cur = minYByBand.get(c.band)
      if (cur === undefined || c.y < cur) minYByBand.set(c.band, c.y)
    }
    // A frame's children ride along as React Flow child nodes, so
    // dragging the frame carries its whole contents — positions become
    // relative to it, and their edges re-route themselves.
    const frameById = new Map(graph.cards.filter(c => c.kind === 'frame').map(c => [c.id, c]))
    // Frames nest, so a fixed frame-behind-cards pair of z-indices is not
    // enough: an inner frame has to sit ABOVE its host's backdrop while
    // still sitting below its own children.
    const depthOf = (card: FocusCard) => {
      let d = 0
      let host = card.frameId
      while (host && d < 32) { d++; host = frameById.get(host)?.frameId ?? null }
      return d
    }
    const nodes: Node[] = graph.cards.map((card) => {
      const parent = card.frameId ? frameById.get(card.frameId) : undefined
      return {
        id: card.id,
        type: card.kind === 'frame' ? 'focusFrame' : card.kind === 'divider' ? 'focusDivider' : 'focusCard',
        zIndex: depthOf(card) * 2 + (card.kind === 'frame' ? 0 : 1),
        ...(parent ? { parentId: parent.id } : {}),
        position: parent
          ? { x: card.x - parent.x, y: card.y - parent.y }
          : { x: card.x, y: card.y },
        // Rearrange the picture freely; a frame's children move with it
        // rather than out of it, so a table never sheds its columns.
        draggable: parent === undefined,
        selectable: false,
        focusable: false,
        data: card.kind === 'focal'
          ? { card, ctx, focalStats: { in: focalIn, out: focalOut, coarser: graph.hopsAtCoarserGrain } }
          : { card, ctx },
      }
    })
    // Hop-band headers with honest shown/total counts.
    for (const [band, minY] of minYByBand) {
      if (band === 0) continue
      const totals = graph.bandTotals.get(`band:${band < 0 ? 'in' : 'out'}:${Math.abs(band)}`)
      // Cards, and — when a card stands for more than itself — what
      // those cards actually hold. A frame is one card and eight
      // connections; printing only "1" beside a focal reading "11 in"
      // left the reader to guess which number was lying.
      const cards = totals
        ? totals.total > totals.shown ? `${totals.shown} of ${totals.total}` : `${totals.total}`
        : undefined
      const sub = totals && cards && totals.connections > totals.total
        ? `${cards} · ${totals.connections.toLocaleString()} connections`
        : cards
      nodes.push({
        id: `bl:${band}`,
        type: 'bandLabel',
        position: { x: band * (CARD_W + BAND_GAP), y: minY - 34 },
        draggable: false,
        selectable: false,
        focusable: false,
        data: { band, sub },
      })
    }
    // A COMPLETED fetch with an empty direction is a data-source claim
    // — whisper it where the band would be, instead of blank space.
    // The user's own type chips REMOVE cards, so an empty band can be
    // their filter rather than the data source's answer. Saying "in the
    // data source" there reported the filter as a fact — chip out the
    // only upstream type and the graph asserted the table has no
    // producers. The builder's own honesty rule already said chips are
    // reported, not silent.
    //
    // And an empty BAND is not an empty SIDE: geometry decides which
    // column a card lands in, and when a shared ancestor pulled every
    // hop column into band 0 this whispered "no upstream sources in the
    // data source" over the sources it was drawing. So the claim is
    // gated on the MODEL (`modelHasUpstream`/`modelHasDownstream`), and
    // a side the model knows about but the picture placed elsewhere gets
    // silence rather than a lie.
    if (focalFetch === 'done') {
      if (!minYByBand.has(-1) && (!graph.modelHasUpstream || directionFilter === 'out' || graph.hiddenByChipsIn > 0)) {
        nodes.push({
          id: 'blw:in', type: 'bandLabel', position: { x: -(CARD_W + BAND_GAP), y: -10 },
          draggable: false, selectable: false, focusable: false,
          data: {
            // Priority: the user's OWN direction filter, then the type
            // chips, then a genuine claim about the data source — never
            // the wrong one of the three.
            whisper: directionFilter === 'out'
              ? 'Upstream hidden — showing Impact only'
              : graph.hiddenByChipsIn > 0
                ? `${graph.hiddenByChipsIn.toLocaleString()} upstream hidden by the type chips`
                : 'No upstream sources in the data source',
          },
        })
      }
      if (!minYByBand.has(1) && (!graph.modelHasDownstream || directionFilter === 'in' || graph.hiddenByChipsOut > 0)) {
        nodes.push({
          id: 'blw:out', type: 'bandLabel', position: { x: CARD_W + BAND_GAP, y: -10 },
          draggable: false, selectable: false, focusable: false,
          data: {
            whisper: directionFilter === 'in'
              ? 'Downstream hidden — showing Root cause only'
              : graph.hiddenByChipsOut > 0
                ? `${graph.hiddenByChipsOut.toLocaleString()} downstream hidden by the type chips`
                : 'No downstream consumers in the data source',
          },
        })
      }
    }
    return nodes
  }, [graph.cards, graph.bandTotals, graph.hiddenByChipsIn, graph.hiddenByChipsOut, graph.hopsAtCoarserGrain,
    graph.modelHasUpstream, graph.modelHasDownstream, ctx, focalIn, focalOut, focalFetch, directionFilter])

  /**
   * Cards the user has dragged, by card id. The builder keeps producing
   * its tidy baked layout; this overlays whatever was moved on top, so
   * an arriving fetch or a newly opened container grows the picture
   * without throwing away the arrangement someone just made.
   *
   * Only the final position is committed (onNodeDragStop) — React Flow
   * moves the node itself during the gesture, so a drag costs exactly
   * one state update rather than one per frame.
   */
  // Stamped with the focal it belongs to and read through, rather than
  // cleared by an effect: a different focal is a different picture, and
  // its arrangement should never leak into the next one.
  const [movedState, setMovedState] = useState<{ focalId: string; positions: ReadonlyMap<string, XYPosition> }>(
    () => ({ focalId, positions: EMPTY_POSITIONS }),
  )
  const moved = movedState.focalId === focalId ? movedState.positions : EMPTY_POSITIONS
  const commitDrag = useCallback((_: unknown, node: Node) => {
    setMovedState(prev => {
      const base = prev.focalId === focalId ? prev.positions : EMPTY_POSITIONS
      const positions = new Map(base)
      positions.set(node.id, { x: node.position.x, y: node.position.y })
      return { focalId, positions }
    })
  }, [focalId])
  const resetLayout = useCallback(() => setMovedState({ focalId, positions: EMPTY_POSITIONS }), [focalId])

  // Selection rides React Flow's own `selected` flag so changing it
  // re-renders exactly the affected memoized cards.
  const nodes = useMemo(() => baseNodes.map((n) => {
    const cardNodeId = (n.data as { card?: FocusCard }).card?.nodeId ?? null
    const sel = cardNodeId != null && cardNodeId === selectedId
    const pos = moved.get(n.id)
    if (sel === !!n.selected && !pos) return n
    return { ...n, selected: sel, ...(pos ? { position: pos } : {}) }
  }), [baseNodes, selectedId, moved])

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const edges = useMemo((): Edge[] => {
    const bandById = new Map(graph.cards.map(c => [c.id, c.band]))
    // Whether the board as a whole is too busy for every badge it could
    // draw — a property of the picture, so it is decided once here
    // rather than re-counted inside every edge.
    const labelDense = graph.edges.filter(e => e.labelVisible).length > LABEL_DENSITY_CAP
    return graph.edges.map((e) => {
      // Containment is never drawn as a wire — it NESTS. Every edge on
      // the board is a lineage hop, tinted by the side it lands on.
      const tint = Math.max(bandById.get(e.source) ?? 0, bandById.get(e.target) ?? 0) <= 0
        ? TINT_UP
        : TINT_DOWN
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'focusEdge',
        // Business users shouldn't infer direction from layout
        // convention alone — every hop carries an explicit arrowhead.
        markerEnd: { type: MarkerType.ArrowClosed, color: tint, width: 14, height: 14 },
        data: {
          count: e.count, dimmed: e.dimmed, tint, cycleBack: e.cycleBack, reducedMotion,
          labelVisible: e.labelVisible, labelDense,
        },
      }
    })
  }, [graph.cards, graph.edges, reducedMotion])

  const reachValue = useMemo(
    () => focalReach ?? null,
    [focalReach],
  )

  // ── Path-to-focus highlight ──────────────────────────────────────
  //
  // Trigger is hover-WITH-INTENT (150ms, so a sweeping pointer doesn't
  // strobe the board) OR selection — hover wins while it is active, so
  // the two can never fight over what is drawn; releasing the hover
  // falls back to whatever is selected, never to nothing.
  const [pathHoverId, setPathHoverId] = useState<string | null>(null)
  const pathHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (pathHoverTimer.current) clearTimeout(pathHoverTimer.current) }, [])

  const focalCardId = useMemo(
    () => graph.cards.find(c => c.nodeId === focalId)?.id ?? null,
    [graph.cards, focalId],
  )
  const selectedCardId = useMemo(
    () => (selectedId ? graph.cards.find(c => c.nodeId === selectedId)?.id ?? null : null),
    [graph.cards, selectedId],
  )
  const pathSourceId = pathHoverId ?? selectedCardId
  // WHICH gesture is asking, carried through so the cards and edges can
  // tell "show me this path" (hover: strengthen only) from "I have
  // chosen this one" (selection: may quiet the rest, to a floor).
  const pathSource: 'hover' | 'select' = pathHoverId ? 'hover' : 'select'
  const pathHighlightValue = useMemo(() => {
    if (!pathSourceId || !focalCardId) return null
    const found = pathToFocus(graph.edges, pathSourceId, focalCardId)
    // Empty means "no path" (a roster extra, or the focus itself) —
    // the contract both here and in pathToFocus is that this dims
    // nothing rather than dimming the whole board for no reason.
    return found.cardIds.size > 0 ? { ...found, source: pathSource } : null
  }, [pathSourceId, pathSource, focalCardId, graph.edges])

  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  useFrameCamera(rf, focalId, graph.cards, graph.edges, reducedMotion)

  // The PEEK belongs to a ROW: a click on one asks "what is this", and
  // this is the answer, beside it. Top-level cards keep the lens's own
  // detail strip — they have room beneath them and no frame to dock to.
  const peekCard = useMemo(
    () => (selectedId ? graph.cards.find(c => c.nodeId === selectedId && c.frameId !== null) ?? null : null),
    [graph.cards, selectedId],
  )
  const peekHost = useMemo(
    () => (peekCard ? graph.cards.find(c => c.id === peekCard.frameId) ?? null : null),
    [graph.cards, peekCard],
  )
  // Esc is deliberately NOT handled here. The lens owns it, in one
  // place, and dismisses progressively: a preview first, then the lens
  // itself. Two window-level capture handlers for one key is how the
  // outer one wins by mount order and the inner one silently never runs.

  return (
    <div
      className={cn(
        'relative h-full w-full min-h-0 text-black/[0.16] dark:text-white/[0.14]',
        // Baked positions + stable card ids: a CSS transform transition
        // makes shared cards glide when the focal changes. The card
        // being dragged opts out — an eased transform lags the pointer.
        !reducedMotion && '[&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-300 [&_.react-flow__node.dragging]:transition-none',
      )}
    >
      <ReachContext.Provider value={reachValue}>
      <HoverContext.Provider value={hoveredId}>
      <PathHighlightContext.Provider value={pathHighlightValue}>
      <RowCursorContext.Provider value={rowCursor}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={setRf}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: FIT_MAX_ZOOM }}
          minZoom={0.25}
          maxZoom={2}
          panOnDrag
          zoomOnScroll
          zoomOnDoubleClick={false}
          // Rearrange the picture to suit how you read it. Edges are
          // anchored to card ids, so every connection re-routes and
          // nothing about the lineage changes — only where it sits.
          nodesDraggable
          // Small movements stay clicks, so dragging never eats the
          // click-to-inspect / double-click-to-focus gestures.
          nodeDragThreshold={4}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onNodeDragStop={commitDrag}
          onPaneClick={() => onSelect(null)}
          onNodeMouseEnter={(_, n) => {
            if (n.type === 'focusCard') setHoveredId(n.id)
            if (n.type !== 'focusCard' && n.type !== 'focusFrame') return
            if (pathHoverTimer.current) clearTimeout(pathHoverTimer.current)
            pathHoverTimer.current = setTimeout(() => setPathHoverId(n.id), 150)
          }}
          onNodeMouseLeave={() => {
            setHoveredId(null)
            if (pathHoverTimer.current) { clearTimeout(pathHoverTimer.current); pathHoverTimer.current = null }
            setPathHoverId(null)
          }}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.25} color="currentColor" />
          <GraphControls
            reducedMotion={reducedMotion}
            exportName={exportName}
            graph={graph}
            focalUrn={focalId}
            onResetLayout={moved.size > 0 ? resetLayout : undefined}
          />
          {peekCard && (
            <LensPeek
              key={peekCard.id}
              card={peekCard}
              host={peekHost}
              ctx={ctx}
              onDismiss={() => onSelect(null)}
            />
          )}
        </ReactFlow>
      </ReactFlowProvider>
      </RowCursorContext.Provider>
      </PathHighlightContext.Provider>
      </HoverContext.Provider>
      </ReachContext.Provider>
    </div>
  )
}
