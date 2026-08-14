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
 *   • isolate → ConeStore, a `useSyncExternalStore` subscription rather
 *               than a `Provider` value (Task 20, P1) — a `Provider`
 *               re-renders every `useContext` consumer regardless of a
 *               memo comparator sitting beside it, which is what made a
 *               single hover-intent toggle re-render every card, frame
 *               and band label on the board; a toggle now re-renders
 *               only the cards/edges whose own on-cone answer changed.
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
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
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
import { CARD_W, BAND_GAP, FRAME_FOOTER_H, FRAME_PAD, headerHeight, holdsRows, labelFitsRun, frameWindow, edgeLabelFor, orientationHalf, type EdgeTypeInfoMap, type FocusCard, type FocusGraph, type FocusPill, type LensReach } from './focus-cards'
import { REVEAL_PAGE, isolationCone, buildWalkExport, walkExportToCsv, type LensDirectionFilter } from './focus-layout'
import { timeAgo } from '@/lib/timeAgo'
import { FIT_MAX_ZOOM, useFrameCamera } from './useFrameCamera'
import { bumpRenderCount } from './renderProbe'

/** Direction tints — the house semantics: upstream = sky, downstream
 *  = amber (matches the list columns and the canvas). */
const TINT_UP = '#0ea5e9'
const TINT_DOWN = '#f59e0b'
/**
 * Off-cone wire colour (Task 20, P2) — `TINT_UP`/`TINT_DOWN` run through
 * the exact matrix `filter: saturate(.35)` applies (the CSS/SVG spec's
 * luminance-preserving saturate matrix, not an HSL desaturation — the
 * two disagree visibly), computed once here rather than asked of the
 * compositor on every off-cone wire. `filter` forces its own render
 * layer per element; a precomputed colour is a plain paint property, and
 * a wide board can carry hundreds of off-cone wires when a cone is
 * active. Screenshot-verified against the `filter` version in the P2
 * report — the two are pixel-equivalent.
 */
const MUTED_TINT_UP = '#5e93ab'
const MUTED_TINT_DOWN = '#c2a370'

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
 * ISOLATION — the visible lineage cone of whatever the reader is
 * pointing at (see `isolationCone` in focus-layout.ts), and the one
 * highlight this board has. `null` = nothing isolated, so nothing dims.
 *
 * It replaced a path-to-focus-only highlight, which answered a narrower
 * question ("how does this reach the focus") with a strictly smaller
 * answer: the focus lies on the cone whenever it is reachable, so one
 * mechanism now says both. `sticky` is whether a CLICK put it there,
 * which is the only difference the treatment makes — a sticky isolation
 * also names itself in a chip that says how to leave.
 */
interface IsolationSnapshot {
  cardIds: ReadonlySet<string>
  edgeIds: ReadonlySet<string>
  /** Drawn hops from the anchor; 0 for the anchor and what it holds. */
  hops: ReadonlyMap<string, number>
  anchorId: string
  sticky: boolean
}

/**
 * A SUBSCRIPTION STORE for the isolation cone (Task 20, P1), delivered
 * through `useSyncExternalStore` instead of `React.Context`.
 *
 * Context does not do what the PERF CONTRACT above claims for it: a
 * `Provider` value change re-renders EVERY `useContext` consumer
 * unconditionally, and the memo comparators sitting beside `useConeState`
 * (:1867 area) cannot stop it — a consumed context change bypasses memo
 * entirely. Measured before touching this (see `perf.test.tsx`, P0):
 * one hover-intent toggle re-rendered every card, frame and band label
 * on the board, not the handful whose cone answer actually changed.
 *
 * `useSyncExternalStore` still notifies every subscriber, but each
 * component's own selector (`onCone`/`isAnchor`/`hopsOf`, called through
 * `useConeState` below) decides whether ITS render is actually needed —
 * React skips the render when the returned PRIMITIVE is `Object.is`-equal
 * to what it returned last time. So a toggle re-renders only the cards
 * whose on-cone/off-cone/hop answer crossed a boundary. Selectors return
 * primitives ONLY (never a fresh object) — see `navCatalogue.ts`'s own
 * note on this: a fresh object from `getSnapshot` reads as "changed"
 * every call and spins into a render loop.
 *
 * One instance per `FocusGraphView` mount (created in a ref, never a
 * module singleton — a lens can have more than one board on screen).
 * `HoverContext`/`ReachContext` are untouched: neither fans out to the
 * whole board the way isolation did, so converting them is not this
 * task's fix.
 */
class ConeStore {
  private value: IsolationSnapshot | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: IsolationSnapshot | null): void {
    if (this.value === next) return
    this.value = next
    // Counted (dev-gated, see renderProbe.ts): the P1 budget is "a sweep
    // fires ≤2 store notifications" — this is that count, measured at
    // its source rather than inferred from how many components re-ran.
    bumpRenderCount('ConeStore.notify')
    for (const listener of this.listeners) listener()
  }

  raw = (): IsolationSnapshot | null => this.value
  onCone = (cardId: string): boolean => this.value != null && this.value.cardIds.has(cardId)
  onConeEdge = (edgeId: string): boolean => this.value != null && this.value.edgeIds.has(edgeId)
  isAnchor = (cardId: string): boolean => this.value != null && this.value.anchorId === cardId
  hopsOf = (cardId: string): number | null => this.value?.hops.get(cardId) ?? null
  /** How many of `cardIds` (a band's own column) are on the cone — for
   *  `BandLabelNode`'s "· N on this path", without the nodes array ever
   *  rebuilding on a hover. */
  countOnCone = (cardIds: readonly string[]): number => {
    if (this.value == null) return 0
    let n = 0
    for (const id of cardIds) if (this.value.cardIds.has(id)) n++
    return n
  }
}

/** Fallback only — `FocusGraphView` always provides its own instance.
 *  A shared default keeps every consumer hook-safe without a null check. */
const IsolationStoreContext = createContext<ConeStore>(new ConeStore())

/**
 * THE TRAIL — a subscription store for "is this card on the walked
 * path", delivered through `useSyncExternalStore` for the exact reason
 * `ConeStore` above is (fix round 1, a real regression caught by
 * review): `trailUrns` used to sit inside the shared `CardCtx` object
 * every card closes over, and it grows a fresh `Set` on every extend/
 * page click that reaches a urn for the first time
 * (`LineageLens.tsx`'s `markAnchor`) — so a fresh `ctx` object followed,
 * and `a.ctx === b.ctx` failed for EVERY card's memo comparator on every
 * such click, not just the one card that gained the mark. One instance
 * per `FocusGraphView` mount, same as `ConeStore`.
 */
class TrailStore {
  private urns: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: ReadonlySet<string>): void {
    if (this.urns === next) return
    this.urns = next
    for (const listener of this.listeners) listener()
  }

  has = (urn: string): boolean => this.urns.has(urn)
}

/** Fallback only — `FocusGraphView` always provides its own instance. */
const TrailStoreContext = createContext<TrailStore>(new TrailStore())

/** Whether `urn` carries THE TRAIL's mark — a primitive boolean read
 *  through the store, so only the card whose OWN answer flips re-renders
 *  (the `ConeStore`/`useConeState` pattern, applied to one flag). */
function useOnTrail(urn: string | null): boolean {
  const store = useContext(TrailStoreContext)
  return useSyncExternalStore(store.subscribe, () => (urn ? store.has(urn) : false))
}

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

/**
 * OFF THE CONE. Quiet enough to read as background, light enough that
 * every name stays legible — the old 30% turned the rest of the board
 * into grey ghosts, and the context you are reading the cone AGAINST is
 * half the value of isolating it.
 *
 * Dimmed AND desaturated, not dimmed alone: opacity by itself flattens
 * the board into one grey wash, while pulling the colour out keeps the
 * shapes and the hierarchy readable and makes the cone's own colour the
 * only saturated thing on screen. That is what the eye actually follows.
 *
 * The desaturation used to be `filter: saturate(.35)` on the whole card
 * — one compositor layer per off-cone element, and a wide board can hold
 * hundreds of them the moment a cone is active. `muteColor` (Task 20,
 * P2) runs the SAME matrix the CSS filter does, once per colour a card
 * actually paints with, and hands the DOM a plain colour instead — no
 * filter, no forced layer. `OFF_CONE_CARD` now carries only the opacity;
 * every accent-coloured element mutes its OWN colour beside it.
 */
const OFF_CONE_CARD = 'opacity-60'
const OFF_CONE_EDGE = 0.28

/**
 * The exact matrix `filter: saturate(s)` applies (CSS Filter Effects §
 * the `saturate` primitive — luminance-preserving, not an HSL
 * desaturation; the two disagree visibly). Used wherever a card would
 * otherwise have reached for the CSS filter on an off-cone accent
 * colour — see `OFF_CONE_CARD`'s doc comment.
 */
function muteColor(hex: string, s = 0.35): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const rp = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b
  const gp = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b
  const bp = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, '0')
  return `#${toHex(rp)}${toHex(gp)}${toHex(bp)}`
}

/** Above this many labelled bundles on one board, a ×N badge stops being
 *  information and becomes texture — so only the ones the reader is
 *  pointing at (hovered, selected, on the isolated cone) keep theirs. */
const LABEL_DENSITY_CAP = 12

/** How long a pointer has to REST on something before its lineage is
 *  isolated. Long enough that crossing the board on the way somewhere
 *  else never strobes it; short enough that resting on a card feels like
 *  it answered rather than like it thought about it. */
const HOVER_INTENT_MS = 250

/** Shared empty overlay — a fresh Map would churn the nodes memo. */
const EMPTY_POSITIONS: ReadonlyMap<string, XYPosition> = new Map()
/** Shared empty trail sets — a caller with no history (the visual
 *  harness) marks nothing, without a fresh Set churning memos. */
const EMPTY_TRAIL: ReadonlySet<string> = new Set()

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
  /** Isolate this element's lineage cone, and keep it isolated — the
   *  sticky half of R5. `null` clears. The CARD id, not the urn: the cone
   *  is a fact about the board, and one entity can be drawn as a frame
   *  whose rows have card ids of their own. */
  onIsolate: (cardId: string | null) => void
  /** Peel ONE layer of what is open, innermost first — the board's own
   *  version of the pane click, for the parts of a frame that are
   *  background but sit above the pane. */
  onDismiss: () => void
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
  /** The card whose lineage cone is STUCK on, from a click. Hovering
   *  overrides it for as long as the pointer rests somewhere. */
  isolatedId?: string | null
  reducedMotion: boolean
  edgeTypeInfo?: EdgeTypeInfoMap
  onSelect: (nodeId: string | null) => void
  /** Stick the isolation on this card, or clear it with null. */
  onIsolate?: (cardId: string | null) => void
  /** Dismiss ONE layer of what is open, innermost first — the pane click
   *  and Escape are the same gesture in two forms, so the lens owns the
   *  order and this is how the board asks for it. Falls back to clearing
   *  the selection where a caller has no layering of its own. */
  onDismiss?: () => void
  /** THE TRAIL: entities the reader explicitly walked through this
   *  session — focus history plus extend/page anchors. Delivered through
   *  `TrailStore` (see its own doc comment), not `CardCtx` — defaults to
   *  empty, so the visual harness and any caller with no history simply
   *  marks nothing. */
  trailUrns?: ReadonlySet<string>
  /** Wires ON the trail: unordered `${urnA}|${urnB}` keys (urns sorted)
   *  for consecutive hops in the walked path — the ones that get the
   *  slightly firmer stroke. */
  trailAdjacent?: ReadonlySet<string>
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
 * Where this card stands in the isolation: it IS what the reader is
 * pointing at, it is on that element's lineage cone, it is off the cone
 * (quiet it, to a floor), or nothing is isolated and it is untouched.
 *
 * `hops` is how far along the cone it sits, and it is what the treatment
 * grades: the near lineage is drawn heavier than the far, so a cone
 * reads as a direction of travel rather than as a second kind of dim.
 */
function useConeState(cardId: string): {
  anchor: boolean
  onCone: boolean
  offCone: boolean
  hops: number | null
} {
  const store = useContext(IsolationStoreContext)
  // Four primitive selectors, not one object one — see ConeStore's own
  // doc comment: a fresh object out of `useSyncExternalStore` reads as
  // "changed" on every notify, which is the render-loop trap the
  // codebase's own `navCatalogue.ts` already ran into and documented.
  const isolating = useSyncExternalStore(store.subscribe, () => store.raw() !== null)
  const onCone = useSyncExternalStore(store.subscribe, () => store.onCone(cardId))
  const anchor = useSyncExternalStore(store.subscribe, () => store.isAnchor(cardId))
  const hops = useSyncExternalStore(store.subscribe, () => store.hopsOf(cardId))
  return { anchor, onCone, offCone: isolating && !onCone, hops }
}

/**
 * How a card on the cone lifts off the board: a hairline of its own type
 * colour and a soft shadow in the same hue, strongest on the element
 * being pointed at and lighter one hop out.
 *
 * The accent is the ENTITY TYPE's, not the app's generic selection
 * purple: on an isolated board the only saturated colour left should be
 * the lineage's own, and a type-coloured lift says which kind of thing
 * each lit card is while it says that it is lit.
 */
function coneLift(accent: string, anchor: boolean, hops: number | null): CSSProperties {
  if (anchor) {
    return { boxShadow: `0 0 0 2px ${accent}, 0 12px 30px -6px ${accent}59, 0 2px 8px ${accent}26` }
  }
  const near = hops != null && hops <= 1
  return {
    boxShadow: near
      ? `0 0 0 1.5px ${accent}b3, 0 8px 22px -8px ${accent}4d`
      : `0 0 0 1px ${accent}80, 0 6px 16px -8px ${accent}33`,
  }
}

/**
 * THE TRAIL — a subtle, persistent mark on a card the reader explicitly
 * walked through this session (re-anchored on it, or grew the board FROM
 * it with a ⊕ click). Minimal, per the rule: a small filled dot, nothing
 * that competes with the isolation's own loud highlight, and no new
 * machinery beyond the history this lens already keeps.
 */
function TrailMark() {
  return (
    <span
      aria-hidden
      title="Part of the path you've walked"
      // The app's own lineage accent, not a generic grey — a corner dot
      // reads as "a fact about this walk" the same colour everything
      // else lineage-shaped already speaks in (the spotlight chip's
      // icon, the cone flow). Solid rather than a translucent grey: at
      // 8px a soft opacity read as almost nothing against the card.
      className="pointer-events-none absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated"
    />
  )
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
      if (x.kind !== y.kind || x.count !== y.count || x.groups !== y.groups || x.key !== y.key
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
 * A name clipped in the MIDDLE, keeping both ends (Task 20, P6).
 *
 * `TailName` clips the front on purpose — it exists for names that
 * differ at the END (`int_clean_orders_t1` vs `_t2`). A frame's own
 * name is not always that shape: this codebase's own tables differ at
 * the FRONT just as often (`stg_`/`int_`/`fct_`/`dim_`), and clipping
 * that away unconditionally produced the reported
 * `…TERMEDIATE_T1` — the front-clip rule answering a question this
 * name was never asking, and reading as a broken word rather than a
 * shortened one. Splitting the string and giving the tail span
 * `flex-shrink-0` means the tail NEVER gives up room and the head
 * truncates into whatever is left — both identifying ends stay
 * readable, whichever end a name's schema-prefix or table-suffix
 * convention actually differs at.
 */
/** Below this many characters, a name fits comfortably at every width
 *  this header renders at — rendering it as a single untouched run
 *  rather than paying the two-span split for nothing. Set from the
 *  reported defect itself: `INTERMEDIATE_T1` (15) is exactly the
 *  length that needed the fix, so the floor sits just under it. */
const MIDDLE_TRUNCATE_FLOOR = 13

function MiddleTruncateName({ children, className, title }: { children: string; className?: string; title?: string }) {
  if (children.length <= MIDDLE_TRUNCATE_FLOOR) {
    // Short enough that the head/tail split buys nothing — one text
    // node, same shape `TailName` renders, so a short name's own
    // discoverability (accessibility tree, copy-paste, this file's own
    // tests) is unchanged from before this task.
    return (
      <span dir="rtl" className={cn('truncate min-w-0 text-left', className)} title={title ?? children}>
        <bdi>{children}</bdi>
      </span>
    )
  }
  const mid = Math.ceil(children.length / 2)
  return (
    <span className={cn('flex min-w-0', className)} title={title ?? children}>
      <span className="truncate min-w-0"><bdi>{children.slice(0, mid)}</bdi></span>
      <span className="flex-shrink-0 whitespace-nowrap"><bdi>{children.slice(mid)}</bdi></span>
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
      {/* A FLOOR under the truncation. The tail is what identifies an
          entity (`int_clean_orders_t1` vs `_t2`), so this elides from the
          left — but with no floor a squeezed row rendered "…ake" for
          Snowflake, which identifies nothing and reads as something
          broken. Below the floor the row's own counts give up their space
          instead; the tooltip carries the whole chain either way. */}
      <TailName className="text-ink-muted min-w-[3.5rem]" title={`in ${chain.join(' › ')}`}>{owner}</TailName>
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

/** ...and where it sits VERTICALLY.
 *
 *  A FRAME hangs its own ⊕ on its HEADER line, beside the name it acts
 *  for. Anything else centres on itself.
 *
 *  Reported live: two pills stacked on one row of `int_clean_orders_t1`.
 *  A frame's ⊕ centred on the frame lands on whichever row happens to
 *  occupy its middle — and a NESTED frame tucks its pill inside, ten
 *  pixels from that row's own, so two different controls acting on two
 *  different things came out as one smudge. The header is the frame's
 *  own line and no row is ever on it, so the collision cannot happen at
 *  any nesting depth. */
const pillAnchor = (card: FocusCard): CSSProperties =>
  holdsRows(card) ? { top: headerHeight(card) / 2 } : { top: '50%' }

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
 * anyway. Scoped by the frame because that is what the id IS — a row OF
 * this list — and it keeps the id readable in a DOM inspector; one
 * entity gets one card (`pushCard` refuses a second), so the urn alone
 * would also be unique. The escape is injective (`_` escapes itself), so
 * two urns differing only in punctuation cannot collide.
 */
const domSafe = (s: string): string =>
  s.replace(/[^a-zA-Z0-9-]/g, c => `_${c.charCodeAt(0).toString(36)}`)
const rowDomId = (frameKey: string, urn: string): string =>
  `lens-row-${domSafe(frameKey)}-${domSafe(urn)}`
/** The list itself, addressable for the same reason its rows are: a row
 *  is not a DOM child of it, so handing the keyboard back to the list
 *  after a click on one has to go through an id. */
const listDomId = (frameKey: string): string => `lens-rows-${domSafe(frameKey)}`

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

/** THE ONE PLACE a pill's three kinds resolve to a walk-hook call —
 *  shared by the on-card control, the focal's inline follow, and the
 *  spotlight chip's bridge button, so none of the three can ever
 *  disagree about what one click does. */
function actOnPill(ctx: CardCtx, pill: FocusPill, dir: 'in' | 'out') {
  if (pill.kind === 'reveal') ctx.onRevealMore?.(pill.key)
  else if (pill.kind === 'page' && pill.cursor) ctx.onPage?.(pillTarget(pill.key), dir, pill.cursor)
  else ctx.onExtend?.(pill.key, pillTarget(pill.key), dir)
}

/**
 * The verb-first label a follow control SPEAKS (R1 — kills T16's raw
 * "+N" pill unit: "+408" told a reader nothing they could act on, and
 * read as a bug, not an answer). 'reveal' is the one kind allowed a
 * number, and it counts CARDS — what will actually arrive on the board,
 * the one thing a reveal can promise exactly. Never a fabricated number:
 * 'extend'/'page' speak in verbs alone until the fetch lands.
 */
function pillVerb(pill: FocusPill, dir: 'in' | 'out'): string {
  const side = dir === 'in' ? 'upstream' : 'downstream'
  if (pill.kind === 'reveal') {
    const n = pill.groups ?? 1
    const noun = dir === 'in' ? 'source' : 'consumer'
    return `Show ${n.toLocaleString()} more ${noun}${n === 1 ? '' : 's'}`
  }
  return pill.kind === 'page' ? `Load more ${side}` : `Load ${side}`
}

/** The hover explanation — where a raw connection count is allowed to
 *  live (T17-E's one-number-system: verbs on the control's own face,
 *  flow counts in hover/peek/wires, never both in one place). */
function pillHoverTitle(card: FocusCard, pill: FocusPill, dir: 'in' | 'out'): string {
  const side = dir === 'in' ? 'upstream' : 'downstream'
  const flows = pill.count != null
    ? ` · ${pill.count.toLocaleString()} data flow${pill.count === 1 ? '' : 's'} recorded`
    : ''
  const cap = pill.kind === 'reveal' && pill.groups != null && pill.groups > REVEAL_PAGE
    ? ` — this click brings the first ${REVEAL_PAGE} of ${pill.groups.toLocaleString()} cards`
    : ''
  const verb = pill.kind === 'reveal' ? 'Shows' : 'Loads'
  return `${verb} the next hop ${side} of ${card.label}${flows}${cap}`
}

/**
 * The ⊕, in one of three states — and the state is the whole point,
 * because they cost different things and promise different things:
 *
 *   reveal — show more of what is ALREADY downloaded. Instant, exact.
 *   page   — ask the server for the rest of THIS node's connections,
 *            with its own cursor.
 *   extend — walk one hop further out from here.
 *
 * QUIET AT REST, GENEROUS ON HOVER (R1). What used to be the SOLE
 * affordance — a small pill spelling out a raw connection count — is now
 * what it collapses BACK to: a compact icon (plus a card-count for a
 * reveal, the one number that means "visible arrivals"). Hovering the
 * element it belongs to (the card/row/frame's own `group` — FrameRow and
 * FocusGraphCard already carried it; FocusFrameNode gained it for this)
 * expands it into a DataHub-style zone with the verb spelled out, at the
 * SAME anchor `gutterPos`/`pillAnchor` always used — the placement
 * contract is unchanged; only what the reader sees at rest and on hover.
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
  const base = 'nodrag pointer-events-auto z-20 absolute -translate-y-1/2 flex items-center justify-center gap-1 h-5 rounded-full border text-[9.5px] font-semibold tabular-nums transition-colors'
  const anchor = pillAnchor(card)
  const side = upstream ? 'upstream' : 'downstream'
  const act = () => actOnPill(ctx, pill, dir)

  if (pill.status === 'loading') {
    return (
      <span style={anchor} className={cn(base, 'w-5 bg-canvas-elevated border-accent-lineage/40', pos)}>
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
        style={anchor}
        className={cn(base, 'w-5 bg-canvas-elevated border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10', pos)}
      >
        <LucideIcons.AlertTriangle className="w-3 h-3" />
      </button>
    )
  }

  const verb = pillVerb(pill, dir)
  const title = pillHoverTitle(card, pill, dir)
  // The one number a follow control's REST state may show: a reveal's
  // card count — a visible arrival, not a flow. Everything else is
  // icon-only at rest: the shape that let eight stacked "+5" pills happen
  // is now impossible — there is nothing left to stack but dots.
  const restCount = pill.kind === 'reveal' ? (pill.groups ?? 1) : null

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); act() }}
      title={title}
      aria-label={title}
      style={anchor}
      className={cn(
        base,
        restCount != null ? 'px-1.5' : 'w-5 px-0',
        // ON HOVER of whichever ancestor `group` this sits inside.
        'group-hover:w-auto group-hover:px-2',
        pill.kind === 'reveal'
          ? 'bg-canvas-elevated border-accent-lineage/60 text-accent-lineage hover:border-accent-lineage hover:bg-accent-lineage/10'
          : 'bg-canvas-elevated border-black/15 dark:border-white/20 text-ink-muted hover:text-accent-lineage hover:border-accent-lineage/50',
        pos,
      )}
    >
      {upstream && <LucideIcons.Plus className="w-2.5 h-2.5 flex-shrink-0" />}
      {restCount != null && <span className="group-hover:hidden">{restCount.toLocaleString()}</span>}
      <span className="hidden group-hover:inline whitespace-nowrap">{verb}</span>
      {!upstream && <LucideIcons.Plus className="w-2.5 h-2.5 flex-shrink-0" />}
    </button>
  )
}

/** The focal's ORIENTATION SENTENCE (R1) carries its own follow control
 *  per direction, inline — a compact icon rather than the gutter pill's
 *  full ghost zone (that one already sits at the card's edge; this is
 *  the SAME action — `actOnPill` — reachable without hunting for it). */
function InlineFollow({ pill, dir, ctx }: { pill: FocusPill; dir: 'in' | 'out'; ctx: CardCtx }) {
  if (!ctx.onRevealMore && !ctx.onExtend && !ctx.onPage) return null
  const verb = pillVerb(pill, dir)
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); actOnPill(ctx, pill, dir) }}
      title={verb}
      aria-label={verb}
      disabled={pill.status === 'loading'}
      className="nodrag flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center text-accent-lineage bg-accent-lineage/12 hover:bg-accent-lineage/20 disabled:opacity-50 transition-colors"
    >
      {pill.status === 'loading'
        ? <LucideIcons.Loader2 className="w-2 h-2 animate-spin" />
        : <LucideIcons.Plus className="w-2 h-2" />}
    </button>
  )
}

/**
 * One direction's line in the spotlight chip — its honest drawn-vs-known
 * text, and the pill (if any) a bridge button can act on.
 *
 * DRAWN vs. KNOWN — see `pillFor`'s own contract (focus-layout.ts): a
 * REVEAL's count is a subset already in hand (drawn = known − remaining);
 * an EXTEND/PAGE's is a remainder BEYOND the model (drawn = everything
 * already fetched; known = that plus the remainder). No pill at all: the
 * walk is drained this way, and drawn IS known. `flowsIn`/`flowsOut` are
 * the anchor's own model degree — exact for a leaf (its subtree is
 * itself); for a container anchor whose hops attach to its rows, this
 * floors rather than overstates "drawn" (clamped), which is why the
 * chip states a count, never a percentage.
 *
 * R1b — THE EMPTY SIDE MUST SPEAK: zero DRAWN is not zero KNOWN. A side
 * with nothing drawn yet a real pill (an unfetched frontier) is exactly
 * the reported "Orders (IoT) has no lineage to Marketing" misread — 0 of
 * 66 upstream flows were FETCHED, not zero recorded — so that shape gets
 * its own honest sentence rather than falling into the "drained" wording.
 */
function spotlightSide(card: FocusCard, dir: 'in' | 'out'): { pill: FocusPill | null; text: string } {
  const pill = dir === 'in' ? card.pillUp : card.pillDown
  const dirWord = dir === 'in' ? 'upstream' : 'downstream'
  const known0 = dir === 'in' ? card.flowsIn : card.flowsOut
  const drawn = Math.max(0, pill?.kind === 'reveal' ? known0 - (pill.count ?? 0) : known0)
  if (!pill) {
    return { pill: null, text: `${known0.toLocaleString()} known ${dirWord} flow${known0 === 1 ? '' : 's'} — every one on this board` }
  }
  if (drawn === 0) {
    return {
      pill,
      text: pill.count != null
        ? `nothing loaded ${dirWord} yet · ${pill.count.toLocaleString()} flow${pill.count === 1 ? '' : 's'} recorded`
        : `nothing loaded ${dirWord} yet — the data source may have more`,
    }
  }
  const known = pill.count != null ? drawn + pill.count : null
  return {
    pill,
    text: known != null
      ? `${drawn.toLocaleString()} of ${known.toLocaleString()} known ${dirWord} flows on this board`
      : `${drawn.toLocaleString()} known ${dirWord} flow${drawn === 1 ? '' : 's'} on this board — the data source may have more`,
  }
}

/**
 * THE SPOTLIGHT CHIP's honest scope (R0 + R1b) — BOTH directions, so an
 * unfetched side can never go silent. The anchor's own NATURAL side (the
 * one its band puts it on — the same side `LensPeek` prefers) always
 * speaks, drained or not, matching the chip's original one-line shape;
 * the OTHER side speaks only when it has something concrete to say (a
 * real pill — the layout asked and got an answer, offered or drained-
 * with-frontier). Staying silent when NEITHER side has a pill nor is the
 * natural one is the pre-existing, honest "this card was never asked"
 * gap — not the reported defect, which is a KNOWN frontier going unsaid.
 */
function spotlightScope(card: FocusCard): {
  up: { pill: FocusPill | null; text: string } | null
  down: { pill: FocusPill | null; text: string } | null
} {
  const natural: 'in' | 'out' = card.band < 0 ? 'in' : 'out'
  const up = spotlightSide(card, 'in')
  const down = spotlightSide(card, 'out')
  return {
    up: natural === 'in' || up.pill ? up : null,
    down: natural === 'out' || down.pill ? down : null,
  }
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
        style={pillAnchor(card)}
        className={cn(
          'pointer-events-none z-20 absolute -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full bg-canvas-elevated border border-black/10 dark:border-white/15 text-ink-muted/50',
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
      // Shrinks BEFORE the owner's name does (which has a floor under
      // it): where the row is tight, a readable "in SILVER" beats a
      // complete count beside a name reading "…ake".
      className="truncate min-w-0 tabular-nums"
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
  const { anchor, onCone, offCone, hops } = useConeState(card.id)
  const onTrail = useOnTrail(card.nodeId)
  const cursor = useContext(RowCursorContext)
  // The frame a row sits in is its containment parent — a row is only
  // ever emitted among its own parent's children.
  const hostKey = card.parentId ?? ''
  const onCursor = cursor !== null && cursor.frameKey === hostKey && cursor.urn === card.nodeId
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  // The row's OWN colour, muted in place of the CSS filter this used to
  // lean on — see OFF_CONE_CARD. Used everywhere `accent` paints
  // something outside the onCone/selected treatment, which stays at
  // full saturation (the two states are mutually exclusive with offCone).
  const displayAccent = offCone ? muteColor(accent) : accent
  const dim = card.dimmed ? (card.connected ? 'opacity-30' : 'opacity-20') : offCone ? OFF_CONE_CARD : undefined

  /**
   * Click a row: preview it, and leave the KEYBOARD where the reader
   * just put their attention — on the list this row belongs to.
   *
   * A row is an `option` its list owns by id, never a DOM child of it
   * (React Flow draws rows as the frame's siblings), so a click that
   * left focus outside the list left every arrow key aimed at the LENS,
   * which walks the focus history — the board replaced under a reader
   * browsing a table. The handoff is what makes T16's row keys reachable
   * with a mouse at all; `preventScroll` because the list lives inside a
   * transformed React Flow viewport and the browser's own scroll-into-
   * view would jump the board.
   */
  const activate = () => {
    ctx.onSelect(card.nodeId)
    // ...and isolate what it flows through. One click, both: the preview
    // says what this row IS, the isolation says where it goes.
    ctx.onIsolate(card.id)
    document.getElementById(listDomId(hostKey))?.focus({ preventScroll: true })
    // AFTER the focus, deliberately: the list parks a fresh cursor on its
    // first visible row when it gains focus, and the row the reader
    // actually clicked is the one that should carry it.
    if (card.nodeId) ctx.onRowCursor(hostKey, card.nodeId)
  }
  // The ⊕ tucks INSIDE a row (there is no outside), so the content
  // yields exactly the room a pill owns and no label runs under one.
  const gutters = gutterEnds(card)
  // The row's flow tally used to hang off its ×N as a tooltip. Both are
  // gone: the peek panel states it in words, scoped to what it actually
  // is ("1 flow in this walk"), which is the honest home for a number
  // that describes the FETCH rather than the entity.

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
        onCursor && 'ring-2 ring-accent-lineage/60',
        dim,
      )}
      style={{
        width: card.w,
        height: card.h,
        ...(card.connected ? { borderLeftWidth: 3, borderLeftColor: displayAccent } : {}),
        paddingLeft: gutters.left ? PILL_ZONE : undefined,
        paddingRight: gutters.right ? PILL_ZONE : undefined,
        // Selected, or lit by an isolation: the ring is the ENTITY TYPE's
        // colour, so a lit board says what each lit thing is.
        ...(selected ? { boxShadow: `0 0 0 2px ${accent}, 0 8px 20px -8px ${accent}59` }
          : onCone ? coneLift(accent, anchor, hops)
            : {}),
      }}
      onWheel={(e) => {
        e.stopPropagation()
        ctx.onFrameWheel(hostKey, e.deltaY)
      }}
      onClick={activate}
      onDoubleClick={(e) => { e.stopPropagation(); if (card.nodeId) ctx.onFocus(card.nodeId) }}
      // The click/double-click instruction used to ride along on every
      // row's native tooltip and, being the browser's own, could wedge
      // over the board rather than dismiss (Task 20, P6, two reported
      // screenshots). Dropped rather than moved to a design-system
      // tooltip: the peek that a click opens states "Focus here ⇧↵"
      // itself, so the instruction is not lost, only said once, where a
      // reader who has already clicked can actually use it.
      title={`${card.label}${card.description ? ` — ${card.description}` : ''}${
        card.connected ? '' : ' — inside this, but no lineage with the focused entity'
      }`}
    >
      {card.wired && <PortHandles />}
      <ContentsChevron card={card} ctx={ctx} />
      <div
        className="relative w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: card.connected ? `${displayAccent}1f` : 'transparent' }}
      >
        <TypeIcon ctx={ctx} typeId={card.type} color={displayAccent} className={cn('w-3.5 h-3.5', !card.connected && 'opacity-60')} />
        {onTrail && <TrailMark />}
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
              style={{ backgroundColor: `${displayAccent}1f`, color: displayAccent }}
            >
              {card.type}
            </span>
          )}
          {card.edgeTypeNorm && card.edgeTypeNorm !== card.frameSharedEdgeType && (
            <>
              <span
                className="w-1 h-1 rounded-full flex-shrink-0"
                style={{ backgroundColor: offCone ? muteColor(generateEdgeColorFromType(card.edgeTypeNorm)) : generateEdgeColorFromType(card.edgeTypeNorm) }}
              />
              <span
                className="truncate uppercase tracking-wide"
                title={ctx.edgeTypeInfo?.get(card.edgeTypeNorm)?.description}
              >
                {edgeLabelFor(card.edgeTypeNorm, ctx.edgeTypeInfo)}
              </span>
            </>
          )}
          {/* NO ×N HERE. It was a WITHIN-MODEL degree — how much of this
              entity the walk happens to have loaded — so it grew as the
              user walked (reported live: ×102 → ×174 under one click)
              while naming nothing that had changed about the entity. A
              number that moves when you look at it is not a fact; it is
              an artefact of looking. What this row says is what it holds
              and what it can still offer; the flows live on the wire
              (once, as a bundle) and in the peek. */}
          {card.contents && (
            <>
              {(card.showType || card.edgeTypeNorm) && <span className="text-ink-muted/40">·</span>}
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
  bumpRenderCount('FocusGraphCard')
  const { card, ctx } = data as unknown as {
    card: FocusCard
    ctx: CardCtx
  }
  // The isolation arrives via a subscription store (`useConeState`, P1)
  // so a hover re-renders only the cards whose cone state actually
  // changed, not every card on the board.
  const { anchor, onCone, offCone, hops } = useConeState(card.id)
  const onTrail = useOnTrail(card.nodeId)
  // One class, decided here: two `opacity-*` utilities on one element
  // are settled by their order in the stylesheet, not in the class list,
  // so the text filter's own dim and the cone floor cannot both be
  // spelled out and left to fight.
  const dim = card.dimmed ? 'opacity-30' : offCone ? OFF_CONE_CARD : undefined
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  // Muted in place of the CSS filter this used to lean on — see
  // OFF_CONE_CARD. `accent` itself stays at full saturation for the
  // onCone/selected treatment, mutually exclusive with offCone.
  const displayAccent = offCone ? muteColor(accent) : accent

  const activate = () => { ctx.onSelect(card.nodeId); ctx.onIsolate(card.id) }
  const keyActivate = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate() }
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
      // Dropped the click/double-click instruction (Task 20, P6) — same
      // reasoning as FrameRow's own title, just above.
      title={`${card.label}${card.description ? ` — ${card.description}` : ''}`}
      style={{
        width: card.w, height: card.h, borderLeftWidth: 3, borderLeftColor: displayAccent,
        ...(selected ? { boxShadow: `0 0 0 2px ${accent}, 0 8px 20px -8px ${accent}59` }
          : onCone ? coneLift(accent, anchor, hops)
            : {}),
      }}
      className={cn(
        'group relative flex items-center gap-2 rounded-lg border border-black/[0.07] dark:border-white/[0.08] px-2.5 cursor-pointer transition-colors bg-black/[0.015] dark:bg-white/[0.02] hover:bg-black/[0.035] dark:hover:bg-white/[0.05] hover:border-accent-lineage/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        dim,
      )}
    >
      {card.wired && <PortHandles />}
      <ContentsChevron card={card} ctx={ctx} />
      {(
        <div
          className="relative w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${displayAccent}1f` }}
        >
          <TypeIcon ctx={ctx} typeId={card.type} color={displayAccent} className="w-3.5 h-3.5" />
          {onTrail && <TrailMark />}
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
                style={{ backgroundColor: offCone ? muteColor(generateEdgeColorFromType(card.edgeTypeNorm)) : generateEdgeColorFromType(card.edgeTypeNorm) }}
              />
              <span
                className="truncate uppercase tracking-wide"
                title={ctx.edgeTypeInfo?.get(card.edgeTypeNorm)?.description}
              >
                {edgeLabelFor(card.edgeTypeNorm, ctx.edgeTypeInfo)}
              </span>
            </>
          )}
          {/* No ×N on a frame either — same accumulator, same reason. */}
          {card.contents && (
            <>
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
function FocusFrameNode({ data, selected }: NodeProps) {
  bumpRenderCount('FocusFrameNode')
  const { card, ctx, focalStats } = data as unknown as {
    card: FocusCard
    ctx: CardCtx
    focalStats?: { coarser: number }
  }
  const { anchor, onCone, offCone, hops } = useConeState(card.id)
  const onTrail = useOnTrail(card.nodeId)
  // A frame nested inside another frame is also one of ITS rows, so it
  // answers to the host's keyboard cursor like any other row does.
  const rowCursor = useContext(RowCursorContext)
  const hostKey = card.frameId ? card.parentId ?? '' : null
  const onCursor = hostKey !== null && rowCursor?.frameKey === hostKey && rowCursor.urn === card.nodeId
  // The Find box is asked for rather than always sitting there — see the
  // header, where 64px of permanent input clipped the honest counts.
  const [findOpen, setFindOpen] = useState(false)
  /**
   * THE FOCUS, in the same node language as everything else it is drawn
   * beside (R7). It used to be a compact card with a separate "Inside X"
   * panel floating below it — two boxes for one entity, with the wires
   * landing on the panel's rows, so the thing the reader asked about read
   * as an orphan above its own contents.
   *
   * What it keeps that a partner frame does not have: the accent border
   * and glow (it is the anchor, and must read as one), the full clickable
   * breadcrumb, the coarser-grain whisper, and the Reach line. Everything
   * else — the rows, the scroll region, Find, Connected|All, the peek,
   * the keyboard — is the SAME machinery, unchanged.
   */
  const isFocal = card.kind === 'focal'
  // Where this node's BODY starts — under whichever header it carries.
  // The focus's is taller (it says what it is, where it lives and how
  // far the walk reached), so every message that sits at the top of the
  // body follows the header rather than a hard-coded offset.
  const bodyTop = headerHeight(card) + 6
  // Does this node hold anything at all? A partner frame only exists
  // BECAUSE it has rows, so this is only ever false for a FOCUS that
  // holds nothing — and a chevron, a Connected|All pair and a Find box
  // over an entity with no inside are three controls that do nothing.
  const hasContents = !isFocal || card.contents !== null
  // Reach arrives via context so a growing walk re-renders ONLY this
  // node — it used to invalidate every node in the graph.
  const focalReach = useContext(ReachContext)
  const accent = card.type === 'not loaded' ? NEUTRAL_ACCENT : ctx.visualFor(card.type).color
  // Muted in place of the CSS filter this used to lean on — see
  // OFF_CONE_CARD. `accent` itself stays at full saturation for the
  // onCone/selected treatment, mutually exclusive with offCone.
  const displayAccent = offCone ? muteColor(accent) : accent
  // Whether anything will sit beside the name — see the name's width.
  // Never on the focal: its provenance is the breadcrumb below the name,
  // where the whole chain is clickable.
  const hasAncestryChip = !isFocal && card.frameId === null
    && (card.ancestry.length > 0 || card.parentLabel !== null)
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
      // A nested frame is one of its host's rows, so it answers to the
      // host's list the way any other row does — including saying whether
      // IT is the one selected.
      {...(hostKey !== null && card.nodeId
        ? { id: rowDomId(hostKey, card.nodeId), role: 'option' as const, 'aria-selected': !!selected }
        : {})}
      style={{
        width: card.w,
        height: card.h,
        borderColor: isFocal ? displayAccent : `${displayAccent}55`,
        ...(isFocal
          ? { background: `linear-gradient(150deg, ${displayAccent}24, ${displayAccent}08 60%)` }
          : {}),
        // In priority: what the reader chose, then what the isolation
        // lights, then the focus's own standing glow (muted with it when
        // off-cone — that glow is not the onCone/selected treatment).
        ...(selected ? { boxShadow: `0 0 0 2px ${accent}, 0 10px 34px -6px ${accent}66` }
          : onCone ? coneLift(accent, anchor, hops)
            : isFocal ? { boxShadow: `0 10px 34px ${displayAccent}33` }
              : {}),
      }}
      className={cn(
        // `group`: what a hover ghost-zone follow control (WalkPill)
        // expands against — the frame/focal root did not carry it before
        // R1, so the pill's own hover had nothing to answer to here.
        'group relative rounded-xl border-2 pointer-events-none',
        // The anchor is SOLID and lit; a partner container is a dashed
        // outline around rows that speak for themselves.
        isFocal ? 'bg-canvas-elevated' : 'border-dashed bg-black/[0.02] dark:bg-white/[0.03]',
        onCursor && 'ring-2 ring-accent-lineage/60',
        offCone && OFF_CONE_CARD,
      )}
    >
      {card.wired && <PortHandles />}
      {onTrail && <TrailMark />}
      {/* An open container keeps its own lineage question: looking
          inside something must never end the walk. */}
      <WalkPills card={card} ctx={ctx} />
      {/* Header — the only interactive part; the body is click-through
          so the child cards above stay reachable. */}
      <div
        className={cn(
          'pointer-events-auto absolute inset-x-0 top-0 px-2.5 flex gap-1.5',
          isFocal ? 'flex-col pt-2' : 'items-center',
        )}
        style={{ height: headerHeight(card) }}
        // A container's header is a place to POINT at it: inspect it, and
        // isolate what runs through it. Its own controls stop the click
        // before it arrives here.
        //
        // A pointer gesture and NOTHING ELSE. This element is not a
        // button and must never become one: it holds a chevron, a
        // Connected|All pair, a Find box and a Focus control, and a
        // button containing buttons and a text input is not a button at
        // all. It had a `role="button"` with an Enter/Space handler for
        // one release, and because a keydown bubbles where a click was
        // stopped, that handler ate the keyboard from every control
        // underneath it — a space could not be typed into Find, and
        // Enter on the chevron selected the frame instead of opening it.
        // Where the FOCUS needs a keyboard way in, it has a real button
        // of its own (its name, below).
        onClick={() => { ctx.onSelect(card.nodeId); ctx.onIsolate(card.id) }}
      >
      <div className={cn('flex items-center gap-1.5 min-w-0', isFocal && 'w-full')}>
        {hasContents && (
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
        )}
        <TypeIcon ctx={ctx} typeId={card.type} color={displayAccent} className="w-3.5 h-3.5 flex-shrink-0" />
        {/* The focus states its KIND on the control line and its NAME on
            a line of its own below — it is the thing the whole board is
            about, and a name sharing a row with four controls is the
            thing most likely to truncate. */}
        {isFocal && (
          <>
            <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] truncate" style={{ color: displayAccent }}>
              {card.type}
            </p>
            {card.fetch === 'loading' && (
              <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/70" aria-label="Fetching lineage from the data source" />
            )}
            <span className="flex-1" />
          </>
        )}
        {!isFocal && (
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
            <MiddleTruncateName className={cn(
              'text-[11.5px] font-semibold text-ink leading-tight',
              hasAncestryChip && 'max-w-[62%] flex-shrink-0',
            )}>
              {card.label}
            </MiddleTruncateName>
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
        )}
        {/* Connected ⇄ All. The default answers "what in here is on this
            lineage"; All answers "what else is in here", with lineage
            still marked wherever it exists.
            The walk model IS the roster for what connects — but only the
            children endpoint knows what ELSE is in there, so this is the
            one control on a frame that can cost a fetch. */}
        {hasContents && ctx.onToggleFrameAll && (
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
        {/* Re-center on this container. The FOCUS is already the centre,
            so it offers no such control — a button that walks you to
            where you are standing is a dead click. */}
        {card.nodeId && !isFocal && (
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
        {/* ── The focus's own identity, under its control line ── */}
        {isFocal && (
          <>
            {/* The focus's name IS its hit area — a real button, so the
                keyboard reaches the same isolation the pointer does
                without the header having to claim to be one. (A partner
                frame needs no such control: its own Focus button walks
                you there, which is the coarser thing a keyboard reader
                wants from a card that is not the subject.) */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); ctx.onSelect(card.nodeId); ctx.onIsolate(card.id) }}
              aria-label={`${card.label} — isolate the lineage running through it`}
              className="nodrag block w-full min-w-0 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <MiddleTruncateName
                className="text-[13px] font-semibold text-ink leading-tight"
                title={`${card.label}${card.description ? ` — ${card.description}` : ''}`}
              >
                {card.label}
              </MiddleTruncateName>
            </button>
            {/* What is in here, on this lineage and altogether — the same
                sentence, decided the same way, that a partner frame's
                header carries. */}
            {hasContents && (
              <p className="flex items-center gap-1 text-[9px] text-ink-muted/80 leading-tight truncate">
                {card.fetch === 'loading'
                  ? 'Looking inside…'
                  : card.contents && !fellBack
                    ? <ContentsCount card={card} />
                    : <span className="truncate">{inside}</span>}
              </p>
            )}
            {card.parentId && <FocalBreadcrumb card={card} ctx={ctx} />}
            {/* Hops the data source attached to a level ABOVE the focus.
                Nothing above the focus is drawn, so there is no card for
                them to land on — but they are facts, and a partner
                sitting there with no wire on it needs the explanation. */}
            {focalStats && focalStats.coarser > 0 && (
              <p
                className="text-[9px] italic text-ink-muted/70 truncate"
                title={`${focalStats.coarser.toLocaleString()} connection${focalStats.coarser === 1 ? '' : 's'} the data source records against a level above ${card.label}. They are drawn nowhere: this picture never boxes the levels above the focus. Focus a breadcrumb above to see them.`}
              >
                +{focalStats.coarser.toLocaleString()} connect at a coarser grain
              </p>
            )}
            {/* THE ORIENTATION SENTENCE (R1) — replaces "Reach: N
                upstream · M downstream" with what the walk actually
                knows in plain language, "across N systems" where that
                says something a raw count does not, and the SAME two
                follow controls the gutter carries — inline, so growing
                the board from here never means hunting for the card's
                own edge. An open frontier still makes these floors, and
                still says so. */}
            {focalReach && (
              <p
                className="flex items-center gap-1 min-w-0 text-[9px] text-ink-muted"
                title={focalReach.moreUp || focalReach.moreDown
                  ? 'What this walk has reached so far. A + marks a floor rather than a total — more exists that way. The buttons here, or the ⊕ on any card, reach further.'
                  : 'Everything connected to this entity, upstream and downstream, as far as the data source goes.'}
              >
                <LucideIcons.Radar className="w-2.5 h-2.5 flex-shrink-0 text-accent-lineage/70" />
                {/* ONE span, ONE ellipsis. Two independently-truncating
                    spans (tried first) cut mid-word on each half at once
                    on a narrow focal — "Fed by 20+ sources across 20 …"
                    beside "feeds nothing down…", neither readable. The
                    follow controls sit OUTSIDE the truncating run, fixed
                    size, so they never fight the sentence for room. */}
                <span className="truncate min-w-0 flex-1 tabular-nums">
                  {orientationHalf('Fed by', 'source', 'upstream', focalReach.up, focalReach.moreUp, focalReach.upSystems, 'No upstream sources')}
                  {' · '}
                  {orientationHalf('feeds', 'consumer', 'downstream', focalReach.down, focalReach.moreDown, focalReach.downSystems, 'feeds nothing downstream')}
                </span>
                {card.pillUp && <InlineFollow pill={card.pillUp} dir="in" ctx={ctx} />}
                {card.pillDown && <InlineFollow pill={card.pillDown} dir="out" ctx={ctx} />}
              </p>
            )}
          </>
        )}
      </div>

      {/* Everything below is about what is INSIDE this node, so none of
          it is drawn on a node with no inside — a focus that holds
          nothing is a compact card, and a sentence about its contents
          would spill straight out of the bottom of it. */}
      {hasContents && card.fetch === 'loading' && (
        <div className="absolute inset-x-2.5 space-y-1.5" style={{ top: bodyTop }}>
          {[0, 1].map(i => (
            <div key={i} className="h-8 rounded-lg bg-black/[0.05] dark:bg-white/[0.06] animate-pulse" />
          ))}
        </div>
      )}
      {hasContents && card.fetch === 'error' && (
        <div className="pointer-events-auto absolute inset-x-2.5 flex items-center gap-1.5 text-[10px] text-amber-700 dark:text-amber-400" style={{ top: bodyTop }}>
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
      {hasContents && card.frameEmpty && card.frameLoaded === 0 && card.fetch === null && (
        <p className="absolute inset-x-2.5 text-[10px] text-ink-muted/70 italic leading-snug" style={{ top: bodyTop }}>
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
  /** Rows past the window that are already in hand — what one click
   *  down would actually deliver. Never counts what is still on the
   *  server: a step control has to promise only what it can give. */
  const below = Math.max(0, win.loaded - win.to)

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
        //
        // THE TRADE, stated: this region is pointer-events-auto, so the
        // slivers of a frame body that are not covered by a row — the
        // gaps between rows and the padding at its edges — no longer
        // reach the pane, and the board cannot be PANNED by grabbing one.
        // Rows were never pan targets either (a React Flow node is not in
        // the pane's subtree, and a frame's rows are not draggable), so
        // what is lost is those slivers and nothing else; the board still
        // pans from anywhere outside a frame. What the region must not
        // also swallow is the pane's other job — dismissing what is open
        // — so it does that itself, below.
        className="nowheel nodrag pointer-events-auto absolute inset-x-0 bottom-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded-b-xl"
        style={{ top: headerHeight(card) }}
        // Addressable, so a click on one of the rows it owns can hand
        // the keyboard back to it — see `FrameRow`'s activate.
        id={listDomId(key)}
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
        // Empty space inside a frame is still background: clicking it
        // drops one layer of what is open, exactly as clicking the board
        // around it does. Without this the region silently ate the pane's
        // dismiss over every open container — and it must be the SAME
        // dismiss, or a click on one side of a frame's border would clear
        // the peek while a click on the other cleared the isolation.
        onClick={() => ctx.onDismiss()}
        onWheel={(e) => { e.stopPropagation(); ctx.onFrameWheel(key, e.deltaY) }}
        onFocus={() => { if (cursorIndex < 0 && rows.length > 0) ctx.onRowCursor(key, rows[win.offset]?.urn ?? rows[0].urn) }}
        // The cursor is a FOCUS affordance: a ring left behind on a list
        // nobody is in points at nothing.
        onBlur={() => ctx.onRowCursor(key, null)}
      />
      {/* WHERE IN THE LIST YOU ARE, and how to move — announced rather
          than left to be discovered.
          Reported: a frame showing 8 of 14 rows said so with a hairline
          scrollbar and 9px of grey text in a corner, and the reader found
          the scrolling by accident. So the strip along the foot states
          the range at a size you can read, offers a CLICK that pages the
          window (the discoverable alternative to a wheel nobody knew
          was there), and a soft edge says which way the rest is. */}
      {win.scrollable && (
        <>
          <FrameScrollThumb card={card} win={win} onScroll={scrollTo} />
          {/* The list continues under this edge. Drawn in the padding
              and the footer strip — the two bands of the frame no row is
              ever placed in — so it is never a gradient over a name. */}
          {win.offset > 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-1 h-4"
              style={{
                top: headerHeight(card),
                background: 'linear-gradient(to bottom, rgb(0 0 0 / 0.11), transparent)',
              }}
            />
          )}
          {below > 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-1 h-4"
              style={{
                bottom: FRAME_FOOTER_H,
                background: 'linear-gradient(to top, rgb(0 0 0 / 0.11), transparent)',
              }}
            />
          )}
          <div
            className="nodrag pointer-events-auto absolute inset-x-2 bottom-0 flex items-center gap-1.5"
            style={{ height: FRAME_FOOTER_H }}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              className="flex-shrink-0 px-1.5 py-px rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-[9.5px] font-medium tabular-nums text-ink-secondary leading-none"
              title={`Rows ${win.from.toLocaleString()}–${win.to.toLocaleString()} of ${
                win.exact ? win.total.toLocaleString() : `${win.total.toLocaleString()}+`
              } inside ${card.label}${card.fetch === 'loading' ? ' — fetching the next page' : ''}`}
            >
              {win.from.toLocaleString()}–{win.to.toLocaleString()} of{' '}
              {win.exact ? win.total.toLocaleString() : `${win.total.toLocaleString()}+`}
            </span>
            {card.fetch === 'loading' && (
              <span className="flex-shrink-0 text-[9.5px] text-accent-lineage/90 leading-none">loading…</span>
            )}
            <span className="flex-1" />
            {win.offset > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); scrollTo(win.offset - win.size) }}
                aria-label={`Show previous ${Math.min(win.size, win.offset)} rows`}
                title={`Show previous ${Math.min(win.size, win.offset)} rows`}
                className={STEP_PILL}
              >
                <LucideIcons.ChevronUp className="w-2.5 h-2.5" />
                {Math.min(win.size, win.offset).toLocaleString()}
              </button>
            )}
            {below > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); scrollTo(win.offset + win.size) }}
                aria-label={`Show next ${Math.min(win.size, below)} rows`}
                title={`Show next ${Math.min(win.size, below)} rows`}
                className={STEP_PILL}
              >
                <LucideIcons.ChevronDown className="w-2.5 h-2.5" />
                {Math.min(win.size, below).toLocaleString()} more
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}

/** The two step controls at the foot of a scrolling list. Quiet at rest,
 *  and it is the accent they take on hover — a control the reader has to
 *  find is worth a colour once they are on it. */
const STEP_PILL = 'nodrag flex-shrink-0 flex items-center gap-0.5 px-1.5 py-px rounded-full border border-black/10 dark:border-white/15 bg-canvas-elevated text-[9.5px] font-medium tabular-nums text-ink-muted leading-none transition-colors hover:text-accent-lineage hover:border-accent-lineage/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

/** The scroll thumb: size says how much of the list is on screen,
 *  position says where. Dragging it moves the window. */
function FrameScrollThumb({ card, win, onScroll }: {
  card: FocusCard
  win: ReturnType<typeof frameWindow>
  onScroll: (offset: number) => void
}) {
  const trackH = Math.max(0, card.h - headerHeight(card) - FRAME_PAD * 2 - FRAME_FOOTER_H)
  const span = Math.max(1, win.loaded)
  const thumbH = Math.max(18, Math.round(trackH * Math.min(1, win.size / span)))
  const travel = Math.max(0, trackH - thumbH)
  const thumbY = win.maxOffset === 0 ? 0 : Math.round(travel * (win.offset / win.maxOffset))
  return (
    <div
      // AT REST, not on hover: a scrollbar that only appears once you are
      // already over the list cannot tell you the list scrolls. It widens
      // under the pointer, which is the affordance for grabbing it.
      className="nodrag group/thumb pointer-events-auto absolute w-2 hover:w-3 transition-[width] rounded-full bg-black/[0.06] dark:bg-white/[0.08]"
      style={{ top: headerHeight(card) + FRAME_PAD, right: 3, height: trackH }}
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
        className="absolute inset-x-0 rounded-full bg-black/30 dark:bg-white/35 group-hover/thumb:bg-accent-lineage/70 transition-colors"
        style={{ top: thumbY, height: thumbH }}
      />
    </div>
  )
}

const MemoFocusFrameNode = memo(FocusFrameNode, (prev, next) => {
  // `selected` is read now (a nested frame is one of its host's rows and
  // says so), so a memo that ignored it would freeze that state.
  if (prev.selected !== next.selected) return false
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { coarser: number } }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx; focalStats?: { coarser: number } }
  return a.ctx === b.ctx
    // Carried by the focus, which is one of these nodes now.
    && a.focalStats?.coarser === b.focalStats?.coarser
    && sameCard(a.card, b.card)
})

const MemoFocusGraphCard = memo(FocusGraphCard, (prev, next) => {
  if (prev.selected !== next.selected) return false
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx }
  return a.ctx === b.ctx && sameCard(a.card, b.card)
})

// ── Band labels ──────────────────────────────────────────────────────

/** Non-interactive header floating above each hop band ("Data Sources
 *  · 30 of 45"), or an italic whisper for an empty direction. */
function BandLabelNode({ data }: NodeProps) {
  bumpRenderCount('BandLabelNode')
  const d = data as unknown as { band?: number; sub?: string; whisper?: string; cardIds?: string[] }
  // HOP CONTEXT while a cone is isolated: how much of THIS column the
  // reader's lineage runs through. Counted here, from the ids the band
  // already knows and the cone already in the store — so the numbers
  // cost nothing and the nodes array never rebuilds on a hover.
  const store = useContext(IsolationStoreContext)
  const isolating = useSyncExternalStore(store.subscribe, () => store.raw() !== null)
  const onPath = useSyncExternalStore(store.subscribe, () => store.countOnCone(d.cardIds ?? []))
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
        ? <LucideIcons.ArrowDownLeft className={cn('w-3 h-3 self-center text-sky-500', isolating && onPath === 0 && 'opacity-40')} />
        : <LucideIcons.ArrowUpRight className={cn('w-3 h-3 self-center text-amber-500', isolating && onPath === 0 && 'opacity-40')} />}
      <span className={cn(
        'text-[9.5px] font-bold uppercase tracking-[0.12em]',
        isolating && onPath === 0 ? 'text-ink-muted/40' : 'text-ink-muted/70',
      )}>
        {isUp
          ? hop === 1 ? 'Data Sources' : `Sources · hop ${hop}`
          : hop === 1 ? 'Data Consumers' : `Consumers · hop ${hop}`}
      </span>
      {d.sub && <span className="text-[9px] tabular-nums text-ink-muted/50">{d.sub}</span>}
      {onPath > 0 && (
        <span
          className="text-[9px] tabular-nums font-semibold text-accent-lineage"
          title="Cards in this column that the isolated lineage runs through"
        >
          · {onPath.toLocaleString()} on this path
        </span>
      )}
    </div>
  )
}

const MemoFrameDividerNode = memo(FrameDividerNode, (prev, next) => {
  const a = prev.data as unknown as { card: FocusCard; ctx: CardCtx }
  const b = next.data as unknown as { card: FocusCard; ctx: CardCtx }
  return a.ctx === b.ctx && sameCard(a.card, b.card)
})

/**
 * The one node type the other three's memo pattern had not reached
 * (Task 20, P4): `baseNodes`'s own memo keeps a band label's `data`
 * reference stable across a selection/peek change (nothing in `data` —
 * `band`/`sub`/`whisper`/`cardIds` — depends on `selectedId`), but with
 * no memo boundary here React Flow re-ran this component anyway on
 * every nodes-array rebuild. Only 2-4 of these exist per board, so the
 * cost was never the fan-out P1 fixed — but "same array refs across an
 * unrelated change" (the brief's own words) means the reference doing
 * nothing is the bug, however small.
 */
const MemoBandLabelNode = memo(BandLabelNode, (prev, next) => prev.data === next.data)

const NODE_TYPES = {
  focusCard: MemoFocusGraphCard,
  focusFrame: MemoFocusFrameNode,
  focusDivider: MemoFrameDividerNode,
  bandLabel: MemoBandLabelNode,
}

// ── Edge ─────────────────────────────────────────────────────────────

function FocusGraphEdgeComp({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  bumpRenderCount('FocusGraphEdgeComp')
  const d = data as unknown as {
    count: number
    aggregated: boolean
    containment: boolean
    dimmed: boolean
    tint: string
    /** The desaturated `tint`, precomputed at build time — see P2. */
    mutedTint: string
    cycleBack?: boolean
    /** The one wire of this loop whose badge outranks the density cap. */
    cycleAnchor?: boolean
    reducedMotion?: boolean
    /** The layout says this bundle's badge has something to say and room
     *  to say it (see `FocusEdge.labelVisible`). */
    labelVisible?: boolean
    /** Too many badges on this board for all of them to be read. */
    labelDense?: boolean
    /** THE TRAIL: this bundle connects two consecutive stops on the
     *  walked path. Minimal treatment — a slightly firmer line, nothing
     *  that competes with the cone's own highlight. */
    trail?: boolean
  }
  // Hover emphasis is derived here from context: the edges ARRAY stays
  // identity-stable, so sweeping the pointer never rebuilds it (nor
  // makes React Flow reconcile every edge).
  const hoveredId = useContext(HoverContext)
  const emphasized = hoveredId != null && (source === hoveredId || target === hoveredId)
  // The isolation — a subscription store rather than context, so a
  // toggle re-renders only the edges whose own on-cone answer changed
  // (Task 20, P1). See ConeStore's doc comment.
  const isoStore = useContext(IsolationStoreContext)
  const onCone = useSyncExternalStore(isoStore.subscribe, () => isoStore.onConeEdge(id))
  const isolating = useSyncExternalStore(isoStore.subscribe, () => isoStore.raw() !== null)
  const offCone = isolating && !onCone
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const strong = emphasized || onCone
  /**
   * HOW FAR ALONG the cone this wire runs — the near lineage reads
   * heavier than the far, so an isolated cone has a direction of travel
   * instead of being one flat band of highlight. Measured at the nearer
   * of its two ends, because a wire is as close as its closest card.
   */
  const sourceHops = useSyncExternalStore(isoStore.subscribe, () => isoStore.hopsOf(source))
  const targetHops = useSyncExternalStore(isoStore.subscribe, () => isoStore.hopsOf(target))
  const coneHops = onCone
    ? Math.min(sourceHops ?? 99, targetHops ?? 99)
    : null
  const adjacent = coneHops !== null && coneHops <= 1
  // Highlighting STRENGTHENS what it points at, and quiets the rest only
  // to a floor that stays legible — a highlight that turns the board into
  // grey ghosts costs the reader the context they are reading against.
  const opacity = d.dimmed ? 0.12
    : strong ? 1
      : offCone ? OFF_CONE_EDGE
        : d.containment ? 0.45 : 0.7
  // A ×N survives density only where the reader is actually looking.
  //
  // So does a CYCLE badge, with one exception per loop: "this lineage
  // loops back" is a fact about the data rather than a count, and two
  // wires between one pair read as a duplicate without it — but every
  // wire of a loop is marked, so on a cyclic estate obeying nothing
  // would put a glyph on every wire on the board. The loop's own
  // nominated wire (`cycleAnchor`) always draws; its partners answer to
  // density like any other badge. A loop is never invisible, and never
  // carpets the board.
  //
  // ...and only where the wire BEING DRAWN can hold one. `labelVisible`
  // is the layout's answer, computed from the geometry it just laid out;
  // these coordinates are React Flow's, and the two disagree for a render
  // whenever a node has not been measured yet — every reveal, and every
  // drag. The layout's stale "yes" then painted a chip over a wire that
  // had collapsed to a point: the reported ×15 ×14 ×13 ×12 ×11 stacked in
  // mid-air with no arrow under them. A badge is a thing SAID ABOUT a
  // wire, so it is decided by the wire that is there.
  const roomForLabel = labelFitsRun(sourceX, sourceY, targetX, targetY)
  const showCount = (d.labelVisible ?? false) && roomForLabel && !d.dimmed && (!d.labelDense || strong)
  const showCycle = (d.cycleBack ?? false) && roomForLabel && !d.dimmed
    && (!d.labelDense || strong || (d.cycleAnchor ?? false))
  const showLabel = showCount || showCycle
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        // A slow drift ALONG the cone, in the direction the data flows —
        // the one piece of motion on this board, and only ever on the
        // wires the reader asked about. A class rather than an inline
        // animation so the app's own reduced-motion rules reach it, both
        // the OS setting and the in-app preference.
        className={cn(onCone && !d.reducedMotion && 'lens-cone-flow')}
        style={{
          // Colour is what the eye follows, so the background gives up
          // its saturation. Dimming alone flattens the board into one grey wash — but
          // a `filter: saturate()` forces its own compositor layer per
          // wire, and a wide board can carry hundreds of them off-cone at
          // once. `mutedTint` is the SAME desaturation, pre-computed once
          // per edge at build time (Task 20, P2) rather than asked of the
          // compositor on every one of them.
          stroke: offCone ? d.mutedTint : d.tint,
          // Three steps, no more: the wire the reader is pointing at and
          // its first hop, the rest of the cone, and the background.
          strokeWidth: onCone
            ? (adjacent ? 3 : 2.25)
            : strong ? (d.aggregated ? 3 : 2.5)
              // THE TRAIL: slightly firmer than the plain background —
              // never louder than the cone or a hover, which still say
              // more (what runs through THIS point, right now).
              : d.trail ? (d.aggregated ? 2.5 : 2)
                : d.aggregated ? 2 : 1.5,
          strokeDasharray: d.containment ? '4 4' : undefined,
          opacity,
          transition: d.reducedMotion ? undefined : 'opacity 140ms ease-out, stroke-width 140ms ease-out',
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: offCone ? OFF_CONE_EDGE : 1 }}
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
 * Vertically centred on the row, but never hanging off the top or
 * bottom of the pane — a panel you have to pan to read is not a peek.
 * Extracted as its own pure function (Task 20, P6/fix round 1) so the
 * clamp is unit-testable directly: jsdom does no real layout, so a
 * component-level render always reads `paneH` as 0, which can never
 * exercise "pane too short to fit the panel" — the exact case this
 * clamp exists for.
 *
 * Unconditional: an earlier version only clamped when
 * `paneH > PEEK_MAX_H + 16`; below that threshold it returned the raw
 * row position — genuinely UNCLAMPED, not merely less padded, so a row
 * near the top or bottom edge of a short window opened a peek running
 * off it. Degrades to "pinned near the top, 8px in" when the pane is
 * too short to fit the panel at all — a defined position rather than
 * none.
 */
// Fast Refresh prefers a component-only file; this stays here rather
// than its own module because it is one line of arithmetic coupled to
// `PEEK_MAX_H`, a constant `LensPeek` itself owns — exported only so
// its own test file can reach it directly.
// eslint-disable-next-line react-refresh/only-export-components
export function clampPeekY(rowY: number, paneH: number): number {
  const half = PEEK_MAX_H / 2
  return Math.max(half + 8, Math.min(rowY, paneH - half - 8))
}

/**
 * Extend-click acknowledgment (Task 20, P5). The ⊕ pill's own spinner
 * already fires the instant the click lands — this is the OTHER half
 * of "within one frame": the delivery zone, which said nothing at all
 * until the fetch resolved. A plausible landing spot, not a prediction
 * — one band further in the pill's own direction, at the triggering
 * card's own height — gone the moment the real cards land, which is
 * when `buildFocusLayout` places them for real.
 *
 * Reuses the app's own shimmer language (`.ghost-shimmer`, globals.css
 * — the same silhouette-plus-sweep the sidebar's loading tree items use)
 * rather than inventing a second one. Positioned in SCREEN space off
 * the board's transform, same as `LensPeek` beside it.
 */
function ExtendGhost({ card, dir }: { card: FocusCard; dir: 'in' | 'out' }) {
  const [tx, ty, zoom] = useStore(s => s.transform)
  const band = card.band + (dir === 'in' ? -1 : 1)
  const x = band * (CARD_W + BAND_GAP) * zoom + tx
  const y = card.y * zoom + ty
  return (
    <div
      className="nodrag nowheel pointer-events-none absolute rounded-lg ghost-shimmer border border-black/[0.07] dark:border-white/[0.09]"
      style={{ left: x, top: y, width: CARD_W * zoom, height: card.h * zoom }}
      aria-hidden
    />
  )
}

/** The key that does the same thing this button does — stated on the
 *  button, so the keyboard is discoverable from the mouse. Honest: these
 *  are T16's own row keys, and a click on a row leaves the keyboard in
 *  that row's list, which is where they work. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="ml-auto flex-shrink-0 px-1 py-px rounded border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] text-[9px] font-sans font-medium text-ink-muted">
      {children}
    </kbd>
  )
}

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
  // bottom of the pane — see `clampPeekY`'s own doc comment.
  const rowY = (card.y + card.h / 2) * zoom + ty
  const y = clampPeekY(rowY, paneH)
  const flows = card.flowsIn + card.flowsOut
  const pill = card.band < 0 ? card.pillUp ?? card.pillDown : card.pillDown ?? card.pillUp
  const pillDir: 'in' | 'out' = pill != null && pill === card.pillUp ? 'in' : 'out'
  const act = 'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

  return (
    <div
      role="dialog"
      aria-label={`Preview of ${card.label}`}
      className="nowheel nodrag absolute z-50 -translate-y-1/2 rounded-xl border border-black/10 dark:border-white/10 bg-canvas-elevated shadow-xl shadow-black/25 overflow-hidden"
      style={{ left: x, top: y, width: PEEK_W }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* The panel wears the ENTITY TYPE's colour, not the app's generic
          accent: it is a card about one thing, and which KIND of thing it
          is is the first question it answers. A wash rather than a block
          — the name has to stay the loudest thing in here. */}
      <div
        className="px-2.5 pt-2.5 pb-2 border-b border-black/[0.07] dark:border-white/[0.08]"
        style={{ background: `linear-gradient(180deg, ${accent}1a, transparent)` }}
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
      </div>
      {/* What the walk knows about it, in words rather than a badge —
          and a floor is marked as a floor, never rounded into a total. */}
      <div className="px-2.5 py-2 space-y-0.5 text-[10px] tabular-nums">
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
          // Connections, like the line above it and like the ⊕ badge this
          // panel's own Walk button carries — one unit everywhere.
          <p className="text-ink-muted/70">
            {pill.count.toLocaleString()} more {pillDir === 'in' ? 'upstream' : 'downstream'} connection
            {pill.count === 1 ? '' : 's'} {pill.kind === 'reveal' ? 'already loaded' : 'not fetched yet'}
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
      <div className="px-2.5 pb-2.5 space-y-1">
        {/* Only the moves this row can actually make. A "walk from here"
            over a drained direction would be a button that does nothing,
            which is the whole complaint the ⊕ states honestly — and the
            handler this kind of pill DISPATCHES to is the one that has to
            be present, not whichever handler happened to be named here. */}
        {pill && (pill.kind === 'reveal' ? ctx.onRevealMore : pill.kind === 'page' ? ctx.onPage : ctx.onExtend) && (
          <button
            type="button"
            // In flight, this is a status rather than a control — the same
            // rule the ⊕ itself obeys, so the two can never disagree about
            // whether a click has been taken. A failed one offers the SAME
            // click again, which is what retry means.
            disabled={pill.status === 'loading'}
            onClick={() => {
              onDismiss()
              if (pill.kind === 'reveal') ctx.onRevealMore?.(pill.key)
              else if (pill.kind === 'page' && pill.cursor) ctx.onPage?.(pillTarget(pill.key), pillDir, pill.cursor)
              else ctx.onExtend?.(pill.key, pillTarget(pill.key), pillDir)
            }}
            className={cn(
              act,
              pill.status === 'error'
                ? 'bg-amber-500/10 border border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20'
                : 'bg-accent-lineage/12 border border-accent-lineage/35 text-accent-lineage hover:bg-accent-lineage/20 disabled:opacity-60',
            )}
          >
            {pill.status === 'loading'
              ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
              : pill.status === 'error'
                ? <LucideIcons.AlertTriangle className="w-3 h-3" />
                : <LucideIcons.Plus className="w-3 h-3" />}
            {pill.status === 'loading'
              ? 'Fetching…'
              : pill.status === 'error'
                ? 'Couldn’t fetch — try again'
                : `Walk further ${pillDir === 'in' ? 'upstream' : 'downstream'}`}
            {pill.status == null && pill.count != null && (
              <span className="ml-auto tabular-nums opacity-70">{pill.count.toLocaleString()}</span>
            )}
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
            <Kbd>⇧ ↵</Kbd>
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
            <Kbd>→</Kbd>
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
  focalFetch,
  focalReach,
  exportName,
  directionFilter = 'both',
  selectedId,
  isolatedId = null,
  trailUrns = EMPTY_TRAIL,
  trailAdjacent = EMPTY_TRAIL,
  reducedMotion,
  edgeTypeInfo,
  onSelect,
  onIsolate: onIsolateProp,
  onDismiss: onDismissProp,
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
  // Isolation is the LENS's state, so it survives everything on this
  // board that rebuilds — and so Escape, which the lens owns in one
  // place, can clear it in the right order. A caller that does not want
  // it (the visual harness) simply never hands one down.
  const onIsolate = useCallback((cardId: string | null) => onIsolateProp?.(cardId), [onIsolateProp])
  const onDismiss = useCallback(() => {
    if (onDismissProp) onDismissProp()
    else onSelect(null)
  }, [onDismissProp, onSelect])

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
    for (const c of graph.cards) if (holdsRows(c) && c.expandKey) m.set(c.expandKey, c)
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
    onIsolate,
    onDismiss,
    onRevealMore,
    onExtend,
    onPage,
  }), [edgeTypeInfo, focalId, visualFor, onSelect, onFocus, onToggleFrame, onFrameScroll, onFrameWheel, onFrameQuery, frameQueryFor, onToggleFrameAll, onRetryFrameAll, onRevealOnCanvas, onOpenDetails, onRowCursor, onIsolate, onDismiss, onRevealMore, onExtend, onPage])

  const baseNodes = useMemo((): Node[] => {
    const minYByBand = new Map<number, number>()
    for (const c of graph.cards) {
      const cur = minYByBand.get(c.band)
      if (cur === undefined || c.y < cur) minYByBand.set(c.band, c.y)
    }
    // A frame's children ride along as React Flow child nodes, so
    // dragging the frame carries its whole contents — positions become
    // relative to it, and their edges re-route themselves.
    // Row HOSTS, which since R7 includes the focus: its contents are its
    // own rows, so they ride along as its React Flow children exactly as
    // a partner frame's do — one node that moves as one piece.
    const frameById = new Map(graph.cards.filter(holdsRows).map(c => [c.id, c]))
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
        // The focus is drawn by the same node as a container frame — one
        // language for anything that holds rows (R7).
        type: holdsRows(card) ? 'focusFrame' : card.kind === 'divider' ? 'focusDivider' : 'focusCard',
        zIndex: depthOf(card) * 2 + (holdsRows(card) ? 0 : 1),
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
          ? { card, ctx, focalStats: { coarser: graph.hopsAtCoarserGrain } }
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
      // Which cards this column holds — so the header can say how much of
      // itself an isolated cone runs through WITHOUT this array ever
      // being rebuilt by a hover. It changes when the board does, and a
      // hover changes the context alone.
      const bandCardIds = graph.cards.filter(c => !c.frameId && c.band === band).map(c => c.id)
      nodes.push({
        id: `bl:${band}`,
        type: 'bandLabel',
        position: { x: band * (CARD_W + BAND_GAP), y: minY - 34 },
        draggable: false,
        selectable: false,
        focusable: false,
        data: { band, sub, cardIds: bandCardIds },
      })
    }
    // The layout could not place the focus and drew it as a last resort.
    // Whatever is on this board is a fragment, so say that here rather
    // than let a lone focal card read as the whole answer.
    if (graph.focusRecovered) {
      nodes.push({
        id: 'blw:recovered', type: 'bandLabel',
        position: { x: -CARD_W, y: (minYByBand.get(0) ?? 0) - 40 },
        draggable: false, selectable: false, focusable: false,
        data: { whisper: 'Showing the focus on its own — the rest of this walk could not be placed.' },
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
  }, [graph.cards, graph.bandTotals, graph.hiddenByChipsIn, graph.hiddenByChipsOut, graph.hopsAtCoarserGrain, graph.focusRecovered,
    graph.modelHasUpstream, graph.modelHasDownstream, ctx, focalFetch, directionFilter])

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
    // For THE TRAIL: which urn each card id backs, so a bundle between
    // two consecutive walked hops can be found regardless of which end
    // the picture happened to draw the wire from.
    const urnById = new Map(graph.cards.map(c => [c.id, c.nodeId]))
    // Whether the board as a whole is too busy for every badge it could
    // draw — a property of the picture, so it is decided once here
    // rather than re-counted inside every edge. EVERY badge counts
    // towards it: a cyclic estate wants a glyph on every wire it draws,
    // and a cap that only measured the ×N counts would read that board
    // as empty and let all of them through.
    const labelDense = graph.edges.filter(e => e.labelVisible || e.cycleBack).length > LABEL_DENSITY_CAP
    return graph.edges.map((e) => {
      // Containment is never drawn as a wire — it NESTS. Every edge on
      // the board is a lineage hop, tinted by the side it lands on.
      const up = Math.max(bandById.get(e.source) ?? 0, bandById.get(e.target) ?? 0) <= 0
      const tint = up ? TINT_UP : TINT_DOWN
      // The off-cone colour, baked in here rather than a `filter` at
      // render time (P2) — a static property of which SIDE the wire is
      // on, exactly like `tint` itself, so this costs nothing extra on a
      // rebuild and nothing at all on a hover.
      const mutedTint = up ? MUTED_TINT_UP : MUTED_TINT_DOWN
      const sUrn = urnById.get(e.source)
      const tUrn = urnById.get(e.target)
      const trail = !!sUrn && !!tUrn && trailAdjacent.has([sUrn, tUrn].sort().join('|'))
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'focusEdge',
        // Business users shouldn't infer direction from layout
        // convention alone — every hop carries an explicit arrowhead.
        markerEnd: { type: MarkerType.ArrowClosed, color: tint, width: 14, height: 14 },
        data: {
          count: e.count, dimmed: e.dimmed, tint, mutedTint, cycleBack: e.cycleBack, reducedMotion,
          cycleAnchor: e.cycleAnchor, labelVisible: e.labelVisible, labelDense, trail,
        },
      }
    })
  }, [graph.cards, graph.edges, reducedMotion, trailAdjacent])

  const reachValue = useMemo(
    () => focalReach ?? null,
    [focalReach],
  )

  // ── Isolation ────────────────────────────────────────────────────
  //
  // Hover-WITH-INTENT, so a pointer crossing the board on its way
  // somewhere else never strobes it; a CLICK makes the same treatment
  // stick. Hover wins while it is active — the two can never fight over
  // what is drawn — and releasing it falls back to whatever was clicked,
  // never to nothing.
  const [hoverConeId, setHoverConeId] = useState<string | null>(null)
  const coneHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (coneHoverTimer.current) clearTimeout(coneHoverTimer.current) }, [])

  const anchorId = hoverConeId ?? isolatedId ?? null
  const isolationValue = useMemo(() => {
    if (!anchorId) return null
    const cone = isolationCone(graph, anchorId)
    // Null means the element touches no drawn wire (a roster extra, an
    // unwired board). The contract here and in `isolationCone` is that
    // this isolates NOTHING rather than dimming everything for no reason.
    return cone && { ...cone, anchorId, sticky: hoverConeId === null }
  }, [anchorId, hoverConeId, graph])
  // THE CHIP's own anchor — independent of whether the CONE found a
  // drawn wire to light (R1b). `isolationCone` returns null the moment
  // an anchor touches no drawn edge at all — a card whose whole upstream
  // is genuinely UNFETCHED is exactly that shape — and the chip used to
  // inherit that null, going silent right where the reported defect
  // lives ("Orders (IoT) has no lineage to Marketing" was actually "0 of
  // 66 upstream flows fetched"). Sticky only (`isolatedId`, not
  // `hoverConeId`): a hover still needs no chip, and while hovering a
  // DIFFERENT card the sticky one's chip still hides — both unchanged
  // from before, just no longer gated on the cone's own success.
  const anchorCard = useMemo(
    () => (hoverConeId === null && isolatedId ? graph.cards.find(c => c.id === isolatedId) ?? null : null),
    [graph.cards, isolatedId, hoverConeId],
  )
  // THE SPOTLIGHT CHIP's honest scope — computed once per anchor change,
  // not per render, and OUTSIDE the JSX so `react-hooks/refs` has a
  // stable, analyzable value to close over rather than an IIFE inline in
  // the return.
  const spotlight = useMemo(
    () => (anchorCard ? spotlightScope(anchorCard) : null),
    [anchorCard],
  )

  // One ConeStore per mount (Task 20, P1) — `isolationValue` stays the
  // single source of truth computed above; this only changes HOW it
  // reaches the board's cards/edges/band-labels. `useLayoutEffect` so the
  // store's subscribers update in the SAME commit, before paint — a
  // hover never shows a stale frame first and a correct one a tick later.
  // `useState`'s lazy initializer, not a ref read during render: this
  // project's hooks lint (react-hooks/refs) forbids `ref.current` reads
  // in the render body, even the classic "lazy-init a stable instance"
  // idiom — the initializer function here runs exactly once, on mount.
  const [isolationStore] = useState(() => new ConeStore())
  useLayoutEffect(() => { isolationStore.set(isolationValue) }, [isolationStore, isolationValue])

  // Same pattern, for THE TRAIL (fix round 1) — `trailUrns` grows on
  // every extend/page click that reaches a new urn, and a store keeps
  // that growth from touching the shared `CardCtx` object every card's
  // memo comparator closes over.
  const [trailStore] = useState(() => new TrailStore())
  useLayoutEffect(() => { trailStore.set(trailUrns) }, [trailStore, trailUrns])

  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  // The pane's own pixel size (Task 20, P5), read off the DOM directly
  // rather than React Flow's `useStore` — that hook needs a
  // `ReactFlowProvider` ANCESTOR, and this component's own body runs
  // OUTSIDE the provider it renders below for its children (`LensPeek`
  // can read it because IT is one of those children; this can't be).
  // A ref costs nothing until the effect that uses it actually runs.
  const containerRef = useRef<HTMLDivElement | null>(null)
  useFrameCamera(rf, focalId, graph.cards, graph.edges, reducedMotion, containerRef)

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
  // Every card with an EXTEND in flight (P5) — 'reveal' never sets
  // `status` (it is instant, no fetch), so this only ever matches an
  // extend or a page, which is what "the delivery zone acknowledges"
  // is about.
  const extendGhosts = useMemo(() => {
    const out: { key: string; card: FocusCard; dir: 'in' | 'out' }[] = []
    for (const c of graph.cards) {
      if (c.pillUp?.status === 'loading') out.push({ key: `${c.id}:in`, card: c, dir: 'in' })
      if (c.pillDown?.status === 'loading') out.push({ key: `${c.id}:out`, card: c, dir: 'out' })
    }
    return out
  }, [graph.cards])
  // Esc is deliberately NOT handled here. The lens owns it, in one
  // place, and dismisses progressively: a preview first, then the lens
  // itself. Two window-level capture handlers for one key is how the
  // outer one wins by mount order and the inner one silently never runs.

  return (
    <div
      ref={containerRef}
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
      <IsolationStoreContext.Provider value={isolationStore}>
      <TrailStoreContext.Provider value={trailStore}>
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
          // Clicking the board behind everything DISMISSES, innermost
          // first — the same order Escape uses, so the two gestures
          // cannot disagree about what one of them means.
          onPaneClick={onDismiss}
          onNodeMouseEnter={(_, n) => {
            if (n.type === 'focusCard') setHoveredId(n.id)
            if (n.type !== 'focusCard' && n.type !== 'focusFrame') return
            if (coneHoverTimer.current) clearTimeout(coneHoverTimer.current)
            coneHoverTimer.current = setTimeout(() => setHoverConeId(n.id), HOVER_INTENT_MS)
          }}
          onNodeMouseLeave={() => {
            setHoveredId(null)
            // Instantly: a cone that lingers after the pointer has left
            // is the board answering a question nobody is asking.
            if (coneHoverTimer.current) { clearTimeout(coneHoverTimer.current); coneHoverTimer.current = null }
            setHoverConeId(null)
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
          {extendGhosts.map(g => (
            <ExtendGhost key={g.key} card={g.card} dir={g.dir} />
          ))}
          {/* THE SPOTLIGHT CHIP (R0 + R1b) — states its scope HONESTLY
              (drawn vs. known, never "everything" by omission, and never
              silent about a side that is simply unfetched) and carries
              its bridge controls: follow either direction's remaining
              lineage (element-precise, grows THIS board), or re-anchor
              on the whole element. Only while it STICKS — a hover needs
              no chip, letting go of it is the exit. Independent of
              whether the CONE lit anything (`anchorCard` above) — an
              anchor touching no drawn wire still gets its chip, which is
              the whole fix for R1b's "said nothing" defect. */}
          {anchorCard && spotlight && (spotlight.up || spotlight.down) && (
            <Panel position="bottom-center" className="!mb-4 pointer-events-auto">
              <div className="flex flex-col gap-1 px-3 py-2 rounded-2xl bg-canvas-elevated/95 border border-black/10 dark:border-white/12 shadow-lg shadow-black/10 backdrop-blur-sm max-w-[440px]">
                <div className="flex items-center gap-2">
                  <LucideIcons.Spline className="w-3.5 h-3.5 flex-shrink-0 text-accent-lineage" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                    <span className="font-semibold">{anchorCard.label}</span>
                    {' · its lineage within this walk'}
                  </span>
                  {anchorCard.nodeId && (
                    <button
                      type="button"
                      onClick={() => onFocus(anchorCard.nodeId!)}
                      className="nodrag flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                    >
                      <LucideIcons.Focus className="w-2.5 h-2.5" />
                      Focus here
                    </button>
                  )}
                  <span className="flex-shrink-0 text-[9.5px] text-ink-muted/70">Esc to clear</span>
                  <button
                    type="button"
                    onClick={() => onIsolate(null)}
                    aria-label="Clear isolation"
                    title="Clear isolation"
                    className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <LucideIcons.X className="w-3 h-3" />
                  </button>
                </div>
                {/* Both directions, each on its own full-width line — R1b
                    means a side cannot be dropped just because it isn't
                    the "interesting" one, so there is no shared row left
                    to omit it from. */}
                {([['up', spotlight.up, 'in'], ['down', spotlight.down, 'out']] as const).map(([key, side, dir]) => side && (
                  <div key={key} className="flex items-center gap-2 pl-6">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-ink-muted tabular-nums">{side.text}</span>
                    {side.pill && (
                      <button
                        type="button"
                        onClick={() => actOnPill(ctx, side.pill!, dir)}
                        disabled={side.pill.status === 'loading'}
                        className="nodrag flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-accent-lineage bg-accent-lineage/12 hover:bg-accent-lineage/20 disabled:opacity-50 transition-colors"
                      >
                        {side.pill.status === 'loading'
                          ? <LucideIcons.Loader2 className="w-2.5 h-2.5 animate-spin" />
                          : <LucideIcons.Plus className="w-2.5 h-2.5" />}
                        {pillVerb(side.pill, dir)}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </ReactFlowProvider>
      </RowCursorContext.Provider>
      </TrailStoreContext.Provider>
      </IsolationStoreContext.Provider>
      </HoverContext.Provider>
      </ReachContext.Provider>
    </div>
  )
}
