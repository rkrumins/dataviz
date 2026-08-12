/**
 * buildLensLayout — pure, deterministic geometry for the Lens graph.
 *
 * Reads a LensSessionState and produces positioned cards, frames and
 * edges. No React, no React Flow, no fetching — the layout is a plain
 * function of the session, so every geometric invariant is testable.
 *
 * The shape of the picture:
 *  - COLUMNS by signed hop (focal at 0, sources negative, consumers
 *    positive). There is NO hop cap — a long walk grows sideways.
 *  - Within a column, cards nest into FRAMES by containment: a card
 *    whose ancestor (via `parents`) is also carded in the same column
 *    sits inside that ancestor's frame, with the ancestor as the
 *    frame's header card (keeping its own pills); cards that share a
 *    known parent that is NOT itself carded group under a synthetic
 *    frame named for it. Nesting depth is unbounded.
 *  - Every hidden row is a COUNTED page, never a silent drop: frames
 *    and columns page through a fixed window and state what is hidden.
 *  - Pills and chevrons are emitted for every card at every depth —
 *    the dual-axis walk never dead-ends for a geometric reason. A
 *    hint number appears only when a degree was measured; unknown
 *    renders as no number, never as 0.
 */
import type { GraphNode } from '@/providers/GraphDataProvider'
import {
  expansionKeyOf,
  shownEdgeFloors,
  visibleRecords,
  type LensDirection,
  type LensFetchState,
  type LensSessionState,
} from './lensGraph'

export const LENS_CARD_W = 240
export const LENS_CARD_H = 64
export const LENS_FOCAL_H = 108
export const LENS_CARD_GAP = 10
export const LENS_COL_GAP = 140
export const LENS_FRAME_HEADER_H = 34
export const LENS_FRAME_PAD = 10
export const LENS_FRAME_FOOTER_H = 26
export const LENS_COLUMN_W = LENS_CARD_W + 2 * LENS_FRAME_PAD + 16
/** Rows per frame page and root entries per column page. */
export const LENS_PAGE_SIZE = 8
export const LENS_COLUMN_PAGE_SIZE = 12

export interface LensPill {
  dir: LensDirection
  state: LensFetchState | 'idle'
  /** Measured remaining edges beyond what is drawn; absent = unknown. */
  hint?: number
  /** Everything measured is on the board — the pill can say "done". */
  exhausted: boolean
}

export interface LensChevron {
  state: LensFetchState | 'idle'
  /** The ontology says this type can hold something (unknown types are
   *  offered — an open that finds nothing says so, which is an answer). */
  offered: boolean
  /** Known child count (server total once opened, childCount before). */
  count?: number
  hasMore?: boolean
  shown: number
}

export interface LensCard {
  id: string
  urn: string
  hop: number
  /** Position relative to the canvas, or to parentFrameId when set. */
  x: number
  y: number
  w: number
  h: number
  parentFrameId?: string
  isFocal: boolean
  label: string
  entityType: string
  qualifiedName?: string
  description?: string
  /** Measured raw-lineage degree; absent = unknown, never zero. */
  degrees?: { in: number; out: number }
  /** Nearest-parent context line for standalone cards ('' when framed). */
  parentLabel: string
  /** Clickable ancestor chain, root-first (focal card only). */
  breadcrumb: Array<{ urn: string; label: string }>
  /** Measured transitive reach (focal card only; floors if truncated). */
  reach?: { up: number; down: number; truncated: boolean }
  pills: { up: LensPill; down: LensPill }
  chevron: LensChevron
}

export interface LensFrame {
  id: string
  /** The containment parent this frame stands for. */
  urn: string
  label: string
  /** Set when the parent is itself a carded entity (header card). */
  headerCardId?: string
  hop: number
  x: number
  y: number
  w: number
  h: number
  parentFrameId?: string
  /** Paging: which member window is shown. */
  page: number
  pageCount: number
  totalMembers: number
  shownMembers: number
}

export interface LensEdgeView {
  id: string
  recordId: string
  sourceCardId: string
  targetCardId: string
  edgeTypeNorm: string
  alsoTypes: string[]
  bundledCount: number
  drillable: boolean
  drillState?: LensFetchState
}

export interface LensBanner {
  kind: 'inherited' | 'truncated' | 'error'
  key: string
  /** inherited: the ancestor whose lineage exists; truncated: reason. */
  detail: string
}

export interface LensColumnMeta {
  hop: number
  x: number
  page: number
  pageCount: number
  totalRoots: number
  shownRoots: number
  /** Visible connections whose outer endpoint sits in this column. */
  connections: number
}

export interface LensLayout {
  cards: LensCard[]
  frames: LensFrame[]
  edges: LensEdgeView[]
  banners: LensBanner[]
  columns: LensColumnMeta[]
}

export interface LensLayoutOptions {
  /** Page index per frame id / column key (`col:<hop>`); default 0. */
  pages?: ReadonlyMap<string, number>
  /** Ontology: can this entity type hold children? Unknown types are
   *  offered the chevron — an open that finds nothing says so. */
  canHaveChildren?: (entityType: string) => boolean
  /** Urns whose OPENED children are presently folded away. Loaded data
   *  is never dropped — a collapsed child that is a lineage partner in
   *  its own right stays on the board. */
  collapsedChildren?: ReadonlySet<string>
  pageSize?: number
  columnPageSize?: number
}

export const lensCardId = (urn: string): string => `card:${urn}`
export const lensFrameId = (urn: string): string => `frame:${urn}`
export const lensColumnKey = (hop: number): string => `col:${hop}`

const labelOf = (nodes: ReadonlyMap<string, GraphNode>, urn: string): string => {
  const n = nodes.get(urn)
  return n?.displayName || urn.split(/[:/.]/).filter(Boolean).pop() || urn
}

interface Entry {
  kind: 'card' | 'frame'
  urn: string
  members: Entry[]
}

export function buildLensLayout(state: LensSessionState, opts: LensLayoutOptions = {}): LensLayout {
  const pageSize = opts.pageSize ?? LENS_PAGE_SIZE
  const columnPageSize = opts.columnPageSize ?? LENS_COLUMN_PAGE_SIZE
  const pages = opts.pages ?? new Map<string, number>()
  const records = visibleRecords(state)
  const floors = shownEdgeFloors(state)

  // ── Which urns are cards ────────────────────────────────────────────
  const cardUrns = new Set<string>([state.focal])
  for (const r of records) {
    if (state.hops.has(r.source)) cardUrns.add(r.source)
    if (state.hops.has(r.target)) cardUrns.add(r.target)
  }
  for (const [parentUrn, kids] of state.children) {
    if (kids.state !== 'done' || !state.hops.has(parentUrn)) continue
    if (opts.collapsedChildren?.has(parentUrn)) continue
    for (const child of kids.urns) if (state.hops.has(child)) cardUrns.add(child)
  }

  // ── Column membership ───────────────────────────────────────────────
  const columnsByHop = new Map<number, string[]>()
  for (const urn of cardUrns) {
    const hop = state.hops.get(urn)
    if (hop === undefined) continue
    const list = columnsByHop.get(hop) ?? []
    list.push(urn)
    columnsByHop.set(hop, list)
  }

  // ── Frame forest per column ─────────────────────────────────────────
  // containerOf(card) = nearest ancestor carded in the SAME column.
  const entryRoots = new Map<number, Entry[]>()
  const entriesByUrn = new Map<string, Entry>()
  for (const [hop, urns] of columnsByHop) {
    const inColumn = new Set(urns)
    const containerOf = new Map<string, string | null>()
    for (const urn of urns) {
      let cursor = state.parents.get(urn) ?? null
      const guard = new Set<string>([urn])
      let hit: string | null = null
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor)
        if (inColumn.has(cursor)) {
          hit = cursor
          break
        }
        cursor = state.parents.get(cursor) ?? null
      }
      containerOf.set(urn, hit)
    }
    // Synthetic grouping for cards with no carded ancestor: group by the
    // immediate parent when 2+ siblings share it.
    const bySharedParent = new Map<string, string[]>()
    for (const urn of urns) {
      if (containerOf.get(urn)) continue
      const parent = state.parents.get(urn)
      if (!parent) continue
      const list = bySharedParent.get(parent) ?? []
      list.push(urn)
      bySharedParent.set(parent, list)
    }

    const entryOf = (urn: string): Entry => {
      let e = entriesByUrn.get(urn)
      if (!e) {
        e = { kind: 'card', urn, members: [] }
        entriesByUrn.set(urn, e)
      }
      return e
    }
    const roots: Entry[] = []
    const rootSeen = new Set<string>()
    const syntheticByParent = new Map<string, Entry>()
    for (const urn of urns) {
      const entry = entryOf(urn)
      const container = containerOf.get(urn)
      if (container) {
        const containerEntry = entryOf(container)
        containerEntry.kind = 'frame'
        containerEntry.members.push(entry)
        continue
      }
      const parent = state.parents.get(urn)
      if (parent && (bySharedParent.get(parent)?.length ?? 0) >= 2) {
        let synthetic = syntheticByParent.get(parent)
        if (!synthetic) {
          synthetic = { kind: 'frame', urn: parent, members: [] }
          syntheticByParent.set(parent, synthetic)
          roots.push(synthetic)
        }
        synthetic.members.push(entry)
        continue
      }
      if (!rootSeen.has(urn)) {
        rootSeen.add(urn)
        roots.push(entry)
      }
    }
    entryRoots.set(hop, roots)
  }

  // ── Pills, chevrons, banners ────────────────────────────────────────
  const pillOf = (urn: string, dir: LensDirection): LensPill => {
    const key = expansionKeyOf(dir, urn)
    const expansion = state.expansions.get(key)
    const degree = state.degrees.get(urn)
    const measured = dir === 'up' ? degree?.in : degree?.out
    const floor = floors.get(key) ?? 0
    const hint = measured !== undefined ? Math.max(0, measured - floor) : undefined
    return {
      dir,
      state: expansion?.state ?? 'idle',
      ...(hint !== undefined ? { hint } : {}),
      exhausted: expansion?.state === 'done' && (hint === undefined ? false : hint === 0),
    }
  }

  const chevronOf = (urn: string): LensChevron => {
    const kids = state.children.get(urn)
    const node = state.nodes.get(urn)
    const offered = node?.entityType
      ? (opts.canHaveChildren?.(node.entityType) ?? true)
      : true
    return {
      state: kids?.state ?? 'idle',
      offered: offered || Boolean(kids),
      ...(kids?.total !== undefined
        ? { count: kids.total }
        : node?.childCount !== undefined
          ? { count: node.childCount }
          : {}),
      ...(kids?.hasMore !== undefined ? { hasMore: kids.hasMore } : {}),
      shown: kids?.urns.length ?? 0,
    }
  }

  const banners: LensBanner[] = []
  const seenInherited = new Set<string>()
  for (const [key, expansion] of state.expansions) {
    if (expansion.isInherited && expansion.inheritedFromUrn) {
      if (!seenInherited.has(expansion.inheritedFromUrn)) {
        seenInherited.add(expansion.inheritedFromUrn)
        banners.push({ kind: 'inherited', key, detail: expansion.inheritedFromUrn })
      }
    }
    if (expansion.state === 'done' && expansion.truncated) {
      banners.push({ kind: 'truncated', key, detail: expansion.truncationReason ?? 'truncated' })
    }
    if (expansion.state === 'error') {
      banners.push({ kind: 'error', key, detail: key })
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────
  const cards: LensCard[] = []
  const frames: LensFrame[] = []
  const columns: LensColumnMeta[] = []
  const renderedCardIds = new Map<string, string>()

  const breadcrumbOf = (urn: string): Array<{ urn: string; label: string }> => {
    const chain: Array<{ urn: string; label: string }> = []
    let cursor = state.parents.get(urn)
    const guard = new Set<string>([urn])
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      chain.unshift({ urn: cursor, label: labelOf(state.nodes, cursor) })
      cursor = state.parents.get(cursor)
    }
    return chain
  }

  const cardHeight = (urn: string): number => (urn === state.focal ? LENS_FOCAL_H : LENS_CARD_H)

  interface Placed {
    h: number
  }

  const placeCard = (
    urn: string,
    hop: number,
    x: number,
    y: number,
    w: number,
    parentFrameId?: string,
  ): Placed => {
    const node = state.nodes.get(urn)
    const isFocal = urn === state.focal
    const h = cardHeight(urn)
    cards.push({
      id: lensCardId(urn),
      urn,
      hop,
      x,
      y,
      w,
      h,
      ...(parentFrameId ? { parentFrameId } : {}),
      isFocal,
      label: labelOf(state.nodes, urn),
      entityType: node?.entityType ?? '',
      ...(node?.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
      ...(node?.description ? { description: node.description } : {}),
      ...(state.degrees.has(urn) ? { degrees: state.degrees.get(urn)! } : {}),
      parentLabel: parentFrameId
        ? ''
        : state.parents.get(urn)
          ? labelOf(state.nodes, state.parents.get(urn)!)
          : '',
      breadcrumb: isFocal ? breadcrumbOf(urn) : [],
      ...(isFocal && state.reach ? { reach: state.reach } : {}),
      pills: { up: pillOf(urn, 'up'), down: pillOf(urn, 'down') },
      chevron: chevronOf(urn),
    })
    renderedCardIds.set(urn, lensCardId(urn))
    return { h }
  }

  /** Frame member ordering: children pages first (server order), then
   *  whatever else the forest put here, insertion-ordered. */
  const orderMembers = (frameUrn: string, members: Entry[]): Entry[] => {
    const kidOrder = new Map<string, number>()
    const kids = state.children.get(frameUrn)
    kids?.urns.forEach((u, i) => kidOrder.set(u, i))
    return [...members].sort((a, b) => {
      const ka = kidOrder.has(a.urn) ? kidOrder.get(a.urn)! : Number.MAX_SAFE_INTEGER
      const kb = kidOrder.has(b.urn) ? kidOrder.get(b.urn)! : Number.MAX_SAFE_INTEGER
      return ka !== kb ? ka - kb : 0
    })
  }

  // All coordinates are ABSOLUTE board coordinates — the view renders
  // flat nodes and never relies on React Flow subflow positioning
  // (parentFrameId remains as pure metadata for the camera and tests).
  const placeEntry = (
    entry: Entry,
    hop: number,
    x: number,
    y: number,
    w: number,
    parentFrameId?: string,
  ): Placed => {
    if (entry.kind === 'card') return placeCard(entry.urn, hop, x, y, w, parentFrameId)

    const frameId = lensFrameId(entry.urn)
    const headerIsCard = cardUrns.has(entry.urn)
    const members = orderMembers(entry.urn, entry.members)
    const page = pages.get(frameId) ?? 0
    const pageCount = Math.max(1, Math.ceil(members.length / pageSize))
    const boundedPage = Math.min(page, pageCount - 1)
    const window = members.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize)

    const innerW = w - 2 * LENS_FRAME_PAD
    const innerX = x + LENS_FRAME_PAD
    let cursorY = y + LENS_FRAME_PAD
    let headerCardId: string | undefined
    // Reserve the frame's slot before its members so the render order
    // stays outer-before-inner.
    const frameIndex = frames.length
    frames.push({
      id: frameId,
      urn: entry.urn,
      label: labelOf(state.nodes, entry.urn),
      hop,
      x,
      y,
      w,
      h: 0,
      ...(parentFrameId ? { parentFrameId } : {}),
      page: boundedPage,
      pageCount,
      totalMembers: members.length,
      shownMembers: window.length,
    })
    if (headerIsCard) {
      const placed = placeCard(entry.urn, hop, innerX, cursorY, innerW, frameId)
      headerCardId = lensCardId(entry.urn)
      cursorY += placed.h + LENS_CARD_GAP
    } else {
      cursorY += LENS_FRAME_HEADER_H
    }
    for (const member of window) {
      const placed = placeEntry(member, hop, innerX, cursorY, innerW, frameId)
      cursorY += placed.h + LENS_CARD_GAP
    }
    let h = cursorY - LENS_CARD_GAP + LENS_FRAME_PAD - y
    if (pageCount > 1) h += LENS_FRAME_FOOTER_H
    const frame = frames[frameIndex]
    frame.h = h
    if (headerCardId) frame.headerCardId = headerCardId
    return { h }
  }

  // Connections per column: a record belongs to the column of its
  // endpoint FARTHER from the focal (the side a band header describes).
  const connectionsByHop = new Map<number, number>()
  for (const r of records) {
    const hs = state.hops.get(r.source)
    const ht = state.hops.get(r.target)
    if (hs === undefined || ht === undefined) continue
    const outer = Math.abs(hs) >= Math.abs(ht) ? hs : ht
    connectionsByHop.set(outer, (connectionsByHop.get(outer) ?? 0) + 1)
  }

  const hops = [...columnsByHop.keys()].sort((a, b) => a - b)
  for (const hop of hops) {
    const roots = entryRoots.get(hop) ?? []
    const colKey = lensColumnKey(hop)
    const page = pages.get(colKey) ?? 0
    const pageCount = Math.max(1, Math.ceil(roots.length / columnPageSize))
    const boundedPage = Math.min(page, pageCount - 1)
    const window = roots.slice(boundedPage * columnPageSize, (boundedPage + 1) * columnPageSize)
    const x = hop * (LENS_COLUMN_W + LENS_COL_GAP)
    let y = 0
    for (const entry of window) {
      const placed = placeEntry(entry, hop, x, y, LENS_COLUMN_W)
      y += placed.h + LENS_CARD_GAP
    }
    columns.push({
      hop,
      x,
      page: boundedPage,
      pageCount,
      totalRoots: roots.length,
      shownRoots: window.length,
      connections: connectionsByHop.get(hop) ?? 0,
    })
  }

  // ── Edges among rendered cards ──────────────────────────────────────
  const edges: LensEdgeView[] = []
  for (const r of records) {
    const sourceCardId = renderedCardIds.get(r.source)
    const targetCardId = renderedCardIds.get(r.target)
    if (!sourceCardId || !targetCardId) continue
    edges.push({
      id: `edge:${r.id}`,
      recordId: r.id,
      sourceCardId,
      targetCardId,
      edgeTypeNorm: r.edgeTypeNorm,
      alsoTypes: r.alsoTypes,
      bundledCount: r.bundledCount,
      drillable: Boolean(r.rollupEdge) && !state.drills.get(r.id)?.recordIds.length,
      ...(state.drills.get(r.id) ? { drillState: state.drills.get(r.id)!.state } : {}),
    })
  }

  return { cards, frames, edges, banners, columns }
}
