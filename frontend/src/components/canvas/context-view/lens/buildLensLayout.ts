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
  recordRenderStates,
  resolveToCarded,
  shownEdgeFloors,
  visibleRecords,
  type LensDirection,
  type LensFetchState,
  type LensRecord,
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
/** Slim mode strip under a connected frame's header card (counts,
 *  Connected|All toggle, walked path). */
export const LENS_FRAME_STRIP_H = 22
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
  /** Shown drillable rollup records with this urn as an EXACT endpoint:
   *  the chevron's first meaning is "open what connects", and these are
   *  what a connected expand would drill. */
  connectedCandidates: number
  /** Aggregate state of drills anchored AT this urn (the connected
   *  expand in flight/landed/failed), for chevron routing + spinners. */
  connectedState?: LensFetchState
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
  /** Inside a connected-context frame: does this member participate in
   *  a shown connection? False renders quiet (the "everything inside"
   *  mode dims what the lineage doesn't reach). Absent elsewhere. */
  connected?: boolean
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
  /** Present on connected-context frames (a done anchored drill exists):
   *  which membership the frame is showing. */
  mode?: 'connected' | 'all'
  /** Direct members participating in a shown connection. */
  connectedCount?: number
  /** Known total contents (children total, else childCount). */
  containedTotal?: number
  /** Pass-through chain folded into this frame's header, outer-first
   *  ("PROD", "CURATED" renders as "B › PROD › CURATED"). */
  walkPath?: string[]
  /** The auto-walk stopped at its step cap, not at a natural end. */
  walkCapped?: boolean
  /** Members matching the active Find filter (absent = no filter). */
  matchedMembers?: number
  /** Absolute y of the mode strip row (header-card frames only). */
  stripY?: number
}

export interface LensEdgeView {
  id: string
  /** Every record this wire stands for — several records can resolve to
   *  the same card pair while their true endpoints are not on the board. */
  recordIds: string[]
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
  /** Column width — grows with the deepest nesting it holds. */
  w: number
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
  /** Urns whose OPENED contents are presently folded away — children
   *  pages AND drills anchored there (the coarse rollup wire returns).
   *  Loaded data is never dropped. */
  collapsedChildren?: ReadonlySet<string>
  /** Frames showing only connected members ('all' when absent). */
  connectedFrames?: ReadonlySet<string>
  /** Anchors whose auto-walk stopped at the step cap (view state). */
  walkCapped?: ReadonlySet<string>
  /** Per-frame member filter (Find box): label substring, case-blind.
   *  Filtering narrows the page window, never the data. */
  frameFilters?: ReadonlyMap<string, string>
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
  const collapsed = opts.collapsedChildren
  const records = visibleRecords(state, collapsed)
  const renderStates = recordRenderStates(state, collapsed)

  /** Endpoints participating in a SHOWN connection ("connected"). */
  const shownEndpoints = new Set<string>()
  for (const r of records) {
    shownEndpoints.add(r.source)
    shownEndpoints.add(r.target)
  }
  /** Everything on a shown endpoint's containment chain (self included)
   *  — the entities a connected-only frame may show. */
  const connectedThrough = new Set<string>()
  for (const urn of shownEndpoints) {
    let cursor: string | undefined | null = urn
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      connectedThrough.add(cursor)
      guard.add(cursor)
      cursor = state.parents.get(cursor) ?? undefined
    }
  }
  /** Urns with a live anchored drill: connected-context frames. */
  const anchoredDone = new Set<string>()
  const anchoredLoading = new Set<string>()
  const anchoredError = new Set<string>()
  for (const drill of state.drills.values()) {
    if (!drill.anchorUrn) continue
    if (drill.state === 'done' && drill.recordIds.length > 0) anchoredDone.add(drill.anchorUrn)
    else if (drill.state === 'loading') anchoredLoading.add(drill.anchorUrn)
    else if (drill.state === 'error') anchoredError.add(drill.anchorUrn)
  }

  // ── Which urns are cards ────────────────────────────────────────────
  const cardUrns = new Set<string>([state.focal])
  for (const r of records) {
    if (state.hops.has(r.source)) cardUrns.add(r.source)
    if (state.hops.has(r.target)) cardUrns.add(r.target)
  }
  // Structure retention: a refined record's wire is replaced by its
  // constituents', but its endpoints ARE the structure — B stays carded
  // (and framed) while the wires inside it get finer. Without this the
  // last drill step would evict every ancestor card at once.
  for (const [id, rs] of renderStates) {
    if (rs !== 'refined') continue
    const r = state.records.get(id)
    if (!r) continue
    if (state.hops.has(r.source)) cardUrns.add(r.source)
    if (state.hops.has(r.target)) cardUrns.add(r.target)
  }
  for (const [parentUrn, kids] of state.children) {
    if (kids.state !== 'done' || !state.hops.has(parentUrn)) continue
    if (collapsed?.has(parentUrn)) continue
    const connectedOnly = opts.connectedFrames?.has(parentUrn)
    for (const child of kids.urns) {
      if (!state.hops.has(child)) continue
      // A connected-only frame shows exactly what the lineage reaches;
      // the rest of the contents stay loaded but off the board until
      // the header toggles back to "everything inside".
      if (connectedOnly && !connectedThrough.has(child)) continue
      cardUrns.add(child)
    }
  }

  // Floors resolve against CARDS, not the page window — paging must
  // never wobble a ⊕ hint. Records that cannot reach the board on both
  // sides do not count against anything.
  const floorRecords: LensRecord[] = []
  for (const r of records) {
    const s = resolveToCarded(state.parents, cardUrns, r.source)
    const t = resolveToCarded(state.parents, cardUrns, r.target)
    if (s && t && s !== t) floorRecords.push(r)
  }
  const floors = shownEdgeFloors(floorRecords)

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

  // ── Pass-through chain demotion ─────────────────────────────────────
  // A refinement chain (auto-walked or manually continued) leaves a
  // tower of single-member frames — C ⊃ PROD ⊃ CURATED — whose
  // intermediates host no connection of their own. Fold each such link
  // into its parent and let the header name the walked path.
  // Conservative on purpose: both link ends must be drilled-open
  // anchors with no shown records, so plain nested containment opens
  // and branching levels never demote.
  const walkPaths = new Map<string, string[]>()
  const demotable = (e: Entry): boolean =>
    e.kind === 'frame' && anchoredDone.has(e.urn) && !shownEndpoints.has(e.urn)
  const demoteChains = (entry: Entry): void => {
    while (
      demotable(entry) &&
      entry.members.length === 1 &&
      demotable(entry.members[0])
    ) {
      const inner = entry.members[0]
      const path = walkPaths.get(entry.urn) ?? []
      path.push(inner.urn, ...(walkPaths.get(inner.urn) ?? []))
      walkPaths.set(entry.urn, path)
      entry.members = inner.members
    }
    for (const m of entry.members) demoteChains(m)
  }
  for (const roots of entryRoots.values()) for (const r of roots) demoteChains(r)

  // ── Pills, chevrons, banners ────────────────────────────────────────
  /** A record the connected expand (or ×N chip) could still drill. */
  const drillableRecord = (r: LensRecord): boolean => {
    if (!r.rollupEdge) return false
    const drill = state.drills.get(r.id)
    return !drill || drill.state === 'error'
  }
  const candidatesByUrn = new Map<string, number>()
  for (const r of records) {
    if (!drillableRecord(r)) continue
    for (const u of [r.source, r.target]) {
      candidatesByUrn.set(u, (candidatesByUrn.get(u) ?? 0) + 1)
    }
  }
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
    const connectedState = anchoredLoading.has(urn)
      ? ('loading' as const)
      : anchoredError.has(urn)
        ? ('error' as const)
        : anchoredDone.has(urn)
          ? ('done' as const)
          : undefined
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
      connectedCandidates: candidatesByUrn.get(urn) ?? 0,
      ...(connectedState ? { connectedState } : {}),
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

  /** Frame member ordering: in a connected-context frame the connected
   *  members lead (the lineage is what the frame was opened for — never
   *  buried behind a pager); within each group children pages keep
   *  server order, then insertion order. */
  const orderMembers = (frameUrn: string, members: Entry[]): Entry[] => {
    const kidOrder = new Map<string, number>()
    const kids = state.children.get(frameUrn)
    kids?.urns.forEach((u, i) => kidOrder.set(u, i))
    const contextual = anchoredDone.has(frameUrn) || opts.connectedFrames?.has(frameUrn)
    return [...members].sort((a, b) => {
      if (contextual) {
        const ra = connectedThrough.has(a.urn) ? 0 : 1
        const rb = connectedThrough.has(b.urn) ? 0 : 1
        if (ra !== rb) return ra - rb
      }
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
    // The Find box narrows the page window, never the data: totals keep
    // naming the full membership so a filter can't masquerade as truth.
    const query = opts.frameFilters?.get(entry.urn)?.trim().toLowerCase()
    const matched = query
      ? members.filter(m => labelOf(state.nodes, m.urn).toLowerCase().includes(query))
      : members
    const page = pages.get(frameId) ?? 0
    const pageCount = Math.max(1, Math.ceil(Math.max(matched.length, 1) / pageSize))
    const boundedPage = Math.min(page, pageCount - 1)
    const window = matched.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize)

    // Connected-context meta: the frame was opened by drilling a rollup
    // anchored at it, so the header owes the honest counts, the
    // Connected|All toggle, and the walked path.
    const contextFrame = anchoredDone.has(entry.urn)
    const kids = state.children.get(entry.urn)
    const node = state.nodes.get(entry.urn)
    const containedTotal = kids?.total ?? node?.childCount
    const connectedCount = entry.members.filter(m => connectedThrough.has(m.urn)).length
    const walkPath = walkPaths.get(entry.urn)?.map(u => labelOf(state.nodes, u))

    const innerW = w - 2 * LENS_FRAME_PAD
    const innerX = x + LENS_FRAME_PAD
    let cursorY = y + LENS_FRAME_PAD
    let headerCardId: string | undefined
    let stripY: number | undefined
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
      ...(query !== undefined && query !== '' ? { matchedMembers: matched.length } : {}),
      ...(contextFrame
        ? {
            mode: opts.connectedFrames?.has(entry.urn) ? ('connected' as const) : ('all' as const),
            connectedCount,
            ...(containedTotal !== undefined ? { containedTotal } : {}),
            ...(opts.walkCapped?.has(entry.urn) ? { walkCapped: true } : {}),
          }
        : {}),
      ...(walkPath && walkPath.length > 0 ? { walkPath } : {}),
    })
    if (headerIsCard) {
      const placed = placeCard(entry.urn, hop, innerX, cursorY, innerW, frameId)
      headerCardId = lensCardId(entry.urn)
      cursorY += placed.h
      if (contextFrame) {
        stripY = cursorY
        cursorY += LENS_FRAME_STRIP_H
      }
      cursorY += LENS_CARD_GAP
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
    if (stripY !== undefined) frame.stripY = stripY
    return { h }
  }

  // Connections per column: a record belongs to the column of its
  // RESOLVED endpoint farther from the focal (the side a band header
  // describes) — true endpoints may not be on the board.
  const connectionsByHop = new Map<number, number>()
  for (const r of floorRecords) {
    const s = resolveToCarded(state.parents, cardUrns, r.source)
    const t = resolveToCarded(state.parents, cardUrns, r.target)
    const hs = s !== undefined ? state.hops.get(s) : undefined
    const ht = t !== undefined ? state.hops.get(t) : undefined
    if (hs === undefined || ht === undefined) continue
    const outer = Math.abs(hs) >= Math.abs(ht) ? hs : ht
    connectionsByHop.set(outer, (connectionsByHop.get(outer) ?? 0) + 1)
  }

  // ── Column widths: a column is as wide as its deepest nesting ───────
  // Cards keep LENS_CARD_W at every depth; frames grow OUTWARD by their
  // padding, so N-deep self-nesting widens the column instead of
  // squeezing the leaves illegible.
  const requiredWidth = (entry: Entry): number => {
    if (entry.kind === 'card') return LENS_CARD_W
    let inner = LENS_CARD_W
    for (const m of entry.members) inner = Math.max(inner, requiredWidth(m))
    return inner + 2 * LENS_FRAME_PAD
  }
  const hops = [...columnsByHop.keys()].sort((a, b) => a - b)
  const widthByHop = new Map<number, number>()
  for (const hop of hops) {
    let w = LENS_COLUMN_W
    for (const root of entryRoots.get(hop) ?? []) w = Math.max(w, requiredWidth(root))
    widthByHop.set(hop, w)
  }
  // Cumulative x outward from the focal column at 0 — a fixed
  // hop × width would overlap the moment one column grows.
  const xByHop = new Map<number, number>()
  const zeroIdx = hops.indexOf(0)
  const anchorIdx = zeroIdx === -1 ? 0 : zeroIdx
  if (hops.length > 0) xByHop.set(hops[anchorIdx], 0)
  for (let i = anchorIdx + 1; i < hops.length; i++) {
    const prev = hops[i - 1]
    xByHop.set(
      hops[i],
      (xByHop.get(prev) ?? 0) + (widthByHop.get(prev) ?? LENS_COLUMN_W) + LENS_COL_GAP,
    )
  }
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const next = hops[i + 1]
    xByHop.set(
      hops[i],
      (xByHop.get(next) ?? 0) - LENS_COL_GAP - (widthByHop.get(hops[i]) ?? LENS_COLUMN_W),
    )
  }

  for (const hop of hops) {
    const roots = entryRoots.get(hop) ?? []
    const colKey = lensColumnKey(hop)
    const page = pages.get(colKey) ?? 0
    const pageCount = Math.max(1, Math.ceil(roots.length / columnPageSize))
    const boundedPage = Math.min(page, pageCount - 1)
    const window = roots.slice(boundedPage * columnPageSize, (boundedPage + 1) * columnPageSize)
    const x = xByHop.get(hop) ?? 0
    const colW = widthByHop.get(hop) ?? LENS_COLUMN_W
    let y = 0
    for (const entry of window) {
      const placed = placeEntry(entry, hop, x, y, colW)
      y += placed.h + LENS_CARD_GAP
    }
    columns.push({
      hop,
      x,
      w: colW,
      page: boundedPage,
      pageCount,
      totalRoots: roots.length,
      shownRoots: window.length,
      connections: connectionsByHop.get(hop) ?? 0,
    })
  }

  // Quiet-vs-connected marking inside connected-context frames — the
  // "everything inside" mode dims what the lineage doesn't reach, and
  // headers never dim.
  for (const frame of frames) {
    if (!anchoredDone.has(frame.urn)) continue
    for (const card of cards) {
      if (card.parentFrameId !== frame.id || card.id === frame.headerCardId) continue
      card.connected = connectedThrough.has(card.urn)
    }
  }

  // ── Wires among rendered cards ──────────────────────────────────────
  // A record's true endpoint may be off the board (level-aligned drill
  // constituents, paged-out members): its wire renders against the
  // nearest RENDERED self-or-ancestor and snaps to the real card the
  // moment it is placed. Records resolving to one pair merge into a
  // single wire; records resolving into a single card vanish (internal
  // detail of something still whole).
  const edges: LensEdgeView[] = []
  const grouped = new Map<string, LensEdgeView>()
  const drillRank: Record<LensFetchState, number> = { done: 1, error: 2, loading: 3 }
  for (const r of records) {
    const s = resolveToCarded(state.parents, renderedCardIds, r.source)
    const t = resolveToCarded(state.parents, renderedCardIds, r.target)
    if (!s || !t || s === t) continue
    const sourceCardId = renderedCardIds.get(s)!
    const targetCardId = renderedCardIds.get(t)!
    const key = `${sourceCardId}|${targetCardId}|${r.edgeTypeNorm}`
    const drill = state.drills.get(r.id)
    const memberDrillable = drillableRecord(r)
    const prev = grouped.get(key)
    if (!prev) {
      grouped.set(key, {
        id: `edge:${key}`,
        recordIds: [r.id],
        sourceCardId,
        targetCardId,
        edgeTypeNorm: r.edgeTypeNorm,
        alsoTypes: [...r.alsoTypes],
        bundledCount: r.bundledCount,
        drillable: memberDrillable,
        ...(drill ? { drillState: drill.state } : {}),
      })
      continue
    }
    prev.recordIds.push(r.id)
    prev.bundledCount += r.bundledCount
    for (const also of r.alsoTypes) {
      if (!prev.alsoTypes.includes(also)) prev.alsoTypes.push(also)
    }
    prev.drillable = prev.drillable || memberDrillable
    if (drill && (!prev.drillState || drillRank[drill.state] > drillRank[prev.drillState])) {
      prev.drillState = drill.state
    }
  }
  edges.push(...grouped.values())

  return { cards, frames, edges, banners, columns }
}
