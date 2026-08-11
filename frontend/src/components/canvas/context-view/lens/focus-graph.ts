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

/** Cards per band before the "+N more" overflow card (paged). */
export const GRAPH_BAND_CAP = 30
/** Focal containment children shown before the overflow card. */
export const CONTAINS_CAP = 8
/** Hard stop for hop expansion per direction. */
export const MAX_BAND = 4
/** Children shown inside an opened container frame before "+N more". */
export const FRAME_CHILD_CAP = 12

export const FRAME_HEADER_H = 46
export const FRAME_PAD = 10

const EMPTY_STRINGS: string[] = []

export const CARD_W = 240
export const FOCAL_H = 120
export const CARD_H = 64
export const GROUP_HEADER_H = 40
export const CONTAINS_H = 36
export const OVERFLOW_H = 36
export const BAND_GAP = 130
export const CARD_GAP = 10
/** Indent for cards nested under a header (group members, constituents). */
export const NEST_INDENT = 16
/** Vertical gap between the focal card and its contains stack. */
export const CONTAINS_STACK_GAP = 18

export type FocusDirection = 'in' | 'out'

export type FocusCardKind = 'focal' | 'entity' | 'group' | 'contains' | 'overflow' | 'frame'

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
 */
export type FocusExpandKind = 'group' | 'open' | 'hop' | 'more' | null

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
  /** Frame cards only — the pass-through levels the open walked
   *  through, so a skipped level is shown rather than hidden. */
  frameBreadcrumb: string[]
  /** Frame cards only — server capped the expansion (counts are floors). */
  frameTruncated: boolean
  /** Frame cards only — opened, and nothing inside connects to the focal. */
  frameEmpty: boolean
  /** Group toggle key into expandedGroups / open key into
   *  openContainers / frontier key into expandedFrontier. */
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
  resolveParent: (id: string) => string | null
  /** isCoarser(partnerType, baseType) — coarser-grain rollup test. */
  isCoarser: (type: string | undefined, baseType: string) => boolean
  expandedGroups: ReadonlySet<string>
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
  /** Per band key `${dir}:${band}`: cards shown vs total available. */
  bandTotals: Map<string, { shown: number; total: number }>
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

const recordCount = (r: NeighborRecord): number => {
  const d = r.edge.data as { isAggregated?: boolean; sourceEdgeCount?: number } | undefined
  return d?.isAggregated ? Math.max(d.sourceEdgeCount ?? 1, 1) : 1
}

export function buildFocusGraph(input: FocusGraphInput): FocusGraph {
  const {
    focalId, incomingRecords, outgoingRecords, edgesByEndpoint, nodeMap,
    containmentEdgeTypes, containsChildren, containsTotal, resolveParent,
    isCoarser, expandedGroups, expandedFrontier, openContainers,
    containerResults, containerStatus, frameQueries, framePages, entityLevels,
    bandPages, query, hiddenTypes, degreeHints, fetchStatus,
  } = input

  const q = query.trim().toLowerCase()
  const matches = (label: string) => q === '' || label.toLowerCase().includes(q)

  const cards: FocusCard[] = []
  const edges: FocusEdge[] = []
  const edgeById = new Map<string, FocusEdge>()
  const bandTotals = new Map<string, { shown: number; total: number }>()
  let hiddenByChips = 0

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
    const e: FocusEdge = { id, source, target, count, edgeTypeNorm, aggregated, containment: false, dimmed }
    edgeById.set(id, e)
    edges.push(e)
  }

  /** Every placed entity: nodeId → card id. A node is never placed
   *  twice — a repeat sighting only adds an edge to the existing card
   *  (this is what makes cyclic lineage safe to expand). */
  const placed = new Map<string, string>()

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
    frameId: null, frameBreadcrumb: EMPTY_STRINGS, frameTruncated: false, frameEmpty: false,
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
  placed.set(focalId, 'f')
  cards.push(focal)

  // The focal's fields are structure, not lineage — showing a dozen of
  // them by default buried the middle of the graph in dashed tethers.
  // Start as one summary card; opening it reveals them.
  const containsPages = bandPages.get('contains') ?? 0
  const containsCap = containsPages > 0 ? CONTAINS_CAP * containsPages : 0
  const containsShown = containsChildren.slice(0, containsCap)
  for (const cid of containsShown) {
    if (placed.has(cid)) continue
    const cNode = nodeMap.get(cid)
    const cLabel = labelOf(cid, cNode)
    const card: FocusCard = {
      ...baseCard(),
      id: `c:${cid}`,
      kind: 'contains',
      nodeId: cid,
      band: 0,
      h: CONTAINS_H,
      label: cLabel,
      type: (cNode?.data?.type as string) ?? 'entity',
      unresolved: !cNode,
      dimmed: !matches(cLabel),
    }
    placed.set(cid, card.id)
    cards.push(card)
    edges.push({
      id: `fe:f->${card.id}`,
      source: 'f',
      target: card.id,
      count: 1,
      edgeTypeNorm: 'contains',
      aggregated: false,
      containment: true,
      dimmed: card.dimmed,
    })
  }
  const containsTotalAll = Math.max(containsChildren.length, containsTotal ?? 0)
  if (containsTotalAll > containsShown.length) {
    cards.push({
      ...baseCard(),
      id: 'more:contains',
      kind: 'overflow',
      nodeId: null,
      band: 0,
      h: OVERFLOW_H,
      label: containsShown.length === 0
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
          const t = (r.neighborNode?.data?.type as string) ?? 'not loaded'
          if (hiddenTypes.has(t)) { hiddenByChips++; continue }
          const aggData = r.edge.data as { isAggregated?: boolean } | undefined
          const n = recordCount(r)
          if (placed.has(r.neighborId)) {
            const existing = placed.get(r.neighborId)!
            const refCard = placed.get(ref.nodeId)
            if (refCard && existing !== refCard) {
              addFlowEdge(dir, refCard, existing, n, r.edgeTypeNorm, !!aggData?.isAggregated, false)
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
              rollup: isCoarser(r.neighborNode?.data?.type as string | undefined, ref.type),
              refs: new Map(),
            }
            entryMap.set(r.neighborId, entry)
          }
          entry.count += n
          if (aggData?.isAggregated) entry.agg = { aggregated: true }
          const refStat = entry.refs.get(ref.nodeId)
          if (refStat) refStat.count += n
          else entry.refs.set(ref.nodeId, { count: n, edgeTypeNorm: r.edgeTypeNorm, aggregated: !!aggData?.isAggregated })
        }
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
      const entries = [...entryMap.values()]
      const groups = new Map<string, BandEntry[]>()
      const standalone: BandEntry[] = []
      const rollups: BandEntry[] = []
      for (const e of entries) {
        if (e.rollup) { rollups.push(e); continue }
        const p = resolveParent(e.nodeId)
        if (p && p !== focalId && !refs.some(r => r.nodeId === p)) {
          const g = groups.get(p)
          if (g) g.push(e)
          else groups.set(p, [e])
        } else {
          standalone.push(e)
        }
      }
      for (const [p, members] of [...groups.entries()]) {
        if (members.length < 2) {
          standalone.push(...members)
          groups.delete(p)
        }
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
        | { kind: 'group'; parentId: string; members: BandEntry[] }
        | { kind: 'entity'; entry: BandEntry }
      const items: BandItem[] = [
        ...groupList.map(([parentId, members]) => ({ kind: 'group' as const, parentId, members })),
        ...standalone.map(entry => ({ kind: 'entity' as const, entry })),
        ...rollups.map(entry => ({ kind: 'entity' as const, entry })),
      ]

      // Band cap + paging → overflow card, totals stay honest.
      const bandKey = `${dir}:${band}`
      const cap = GRAPH_BAND_CAP * (1 + (bandPages.get(bandKey) ?? 0))
      const shown = items.slice(0, cap)
      bandTotals.set(bandKey, { shown: Math.min(items.length, cap), total: items.length })

      const nextRefs: Array<{ nodeId: string; type: string }> = []
      const isOutermost = band === MAX_BAND

      const placeEntity = (entry: BandEntry) => {
        const label = labelOf(entry.nodeId, entry.node)
        const type = (entry.node?.data?.type as string) ?? 'not loaded'
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
        const canOpen = entry.rollup && entityLevels?.get(type) !== undefined
        const canHop = !isOutermost && (degreeHints?.get(entry.nodeId)?.[dir] ?? -1) !== 0
        const expandKind: FocusExpandKind = canOpen ? 'open' : canHop ? 'hop' : null
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
          count: entry.count,
          edgeTypeNorm: entry.edgeTypeNorm,
          rollup: entry.rollup,
          unresolved: !entry.node,
          aggregated: entry.agg.aggregated,
          expandKey: canOpen ? openKey : frontierKey,
          expandKind,
          previewLabels: canOpen
            ? (containerResults?.get(openKey)?.nodes ?? []).slice(0, 3).map(n => labelOf(n.id, n))
            : EMPTY_STRINGS,
          frontier: expandKind === 'hop' || expandKind === 'open',
          frontierExpanded,
          degreeHint: degreeHints?.get(entry.nodeId) ?? null,
          fetch: fetchStatus?.get(entry.nodeId) === 'loading' ? 'loading'
            : fetchStatus?.get(entry.nodeId) === 'error' ? 'error' : null,
          dimmed: !matches(label),
        }
        placed.set(entry.nodeId, card.id)
        cards.push(card)
        for (const [refId, stat] of entry.refs) {
          const refCard = placed.get(refId)
          if (refCard) addFlowEdge(dir, refCard, card.id, stat.count, stat.edgeTypeNorm, stat.aggregated, card.dimmed)
        }
        if (frontierExpanded && !isOutermost) nextRefs.push({ nodeId: entry.nodeId, type })

        return card
      }

      /**
       * An OPENED container: a frame standing for the container, holding
       * the entities inside it that carry lineage to the focal. Children
       * go through the same card shape as any neighbour — they get their
       * own expand affordance, counts, edges and hover actions — so
       * exploration continues through them instead of dead-ending, which
       * is what the old terminal constituent cards did.
       */
      const placeOpenContainer = (entry: BandEntry, openKey: string) => {
        const label = labelOf(entry.nodeId, entry.node)
        const type = (entry.node?.data?.type as string) ?? 'not loaded'
        const res = containerResults?.get(openKey)
        const status = containerStatus?.get(openKey)
        const frameId = `fr:${dir}:${entry.nodeId}`

        // Only entities we haven't already placed elsewhere on the board.
        const inside = (res?.nodes ?? []).filter(n => !placed.has(n.id))
        const fq = (frameQueries?.get(openKey) ?? '').trim().toLowerCase()
        const frameCap = FRAME_CHILD_CAP * (1 + (framePages?.get(openKey) ?? 0))
        const shownInside = inside.slice(0, frameCap)

        const frame: FocusCard = {
          ...baseCard(),
          id: frameId,
          kind: 'frame',
          nodeId: entry.nodeId,
          band: sign * band,
          label,
          description: (entry.node?.data?.description as string | undefined) ?? null,
          type,
          count: inside.length,
          rollup: entry.rollup,
          unresolved: !entry.node,
          expandKey: openKey,
          expandKind: 'open',
          expanded: true,
          frontier: true,
          frontierExpanded: true,
          frameBreadcrumb: (res?.passedThrough ?? []).map(n => labelOf(n.id, n)),
          frameTruncated: res?.truncated ?? false,
          frameEmpty: res?.empty ?? false,
          fetch: status === 'loading' ? 'loading' : status === 'error' ? 'error' : null,
          dimmed: !matches(label),
        }
        placed.set(entry.nodeId, frameId)
        cards.push(frame)

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

        for (const child of shownInside) {
          const cLabel = labelOf(child.id, child)
          const cType = (child.data?.type as string) ?? 'not loaded'
          const childOpenKey = `${dir}:${child.id}`
          const childCanOpen = isCoarser(cType, focalType) && entityLevels?.get(cType) !== undefined
          const childCanHop = !isOutermost && (degreeHints?.get(child.id)?.[dir] ?? -1) !== 0
          const childKind: FocusExpandKind = childCanOpen ? 'open' : childCanHop ? 'hop' : null
          const childFrontierKey = `${dir}:${child.id}`
          const childExpanded = expandedFrontier.has(childFrontierKey)
          const cCard: FocusCard = {
            ...baseCard(),
            id: `n:${child.id}`,
            kind: 'entity',
            nodeId: child.id,
            band: sign * band,
            label: cLabel,
            description: (child.data?.description as string | undefined) ?? null,
            type: cType,
            parentId: entry.nodeId,
            parentLabel: label,
            count: countFor(child.id),
            edgeTypeNorm: edgeTypeFor(child.id),
            frameId,
            expandKey: childCanOpen ? childOpenKey : childFrontierKey,
            expandKind: childKind,
            frontier: childKind !== null,
            frontierExpanded: childExpanded,
            degreeHint: degreeHints?.get(child.id) ?? null,
            fetch: fetchStatus?.get(child.id) === 'loading' ? 'loading'
              : fetchStatus?.get(child.id) === 'error' ? 'error' : null,
            // The frame's own filter dims, exactly like the global one.
            dimmed: !matches(cLabel) || (fq !== '' && !cLabel.toLowerCase().includes(fq)),
          }
          placed.set(child.id, cCard.id)
          cards.push(cCard)
          // Children carry the flow to whatever the container connected to.
          for (const [refId, stat] of entry.refs) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, cCard.id, stat.count, cCard.edgeTypeNorm, false, cCard.dimmed)
          }
          if (childExpanded && !isOutermost) nextRefs.push({ nodeId: child.id, type: cType })
        }

        if (inside.length > frameCap) {
          cards.push({
            ...baseCard(),
            id: `more:fr:${dir}:${entry.nodeId}`,
            kind: 'overflow',
            nodeId: null,
            band: sign * band,
            h: OVERFLOW_H,
            label: `+${(inside.length - frameCap).toLocaleString()} more inside`,
            type: 'entity',
            frameId,
            expandKey: openKey,
            expandKind: 'more',
            overflowCount: inside.length - frameCap,
          })
        }

        // With nothing rendered inside (loading, empty, error) the frame
        // would float unconnected — keep its own edge so the picture
        // still reads.
        if (shownInside.length === 0) {
          for (const [refId, stat] of entry.refs) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, frameId, stat.count, stat.edgeTypeNorm, stat.aggregated, frame.dimmed)
          }
        }
      }

      for (const item of shown) {
        if (item.kind === 'entity') {
          const openKey = `${dir}:${item.entry.nodeId}`
          if (item.entry.rollup && openContainers.has(openKey)) placeOpenContainer(item.entry, openKey)
          else placeEntity(item.entry)
          continue
        }
        // Parent group — collapsed: ONE card standing for its members
        // (exactly the members with real lineage records, nothing
        // else); expanded: a slim header + each member as a full card.
        const groupKey = `${dir}:${item.parentId}`
        const expanded = expandedGroups.has(groupKey)
        const pNode = nodeMap.get(item.parentId)
        const pLabel = labelOf(item.parentId, pNode)
        const sum = item.members.reduce((acc, m) => acc + m.count, 0)
        const memberMatches = item.members.reduce(
          (acc, m) => acc + (matches(labelOf(m.nodeId, m.node)) ? 1 : 0), 0)
        const gCard: FocusCard = {
          ...baseCard(),
          id: `g:${dir}:${item.parentId}`,
          kind: 'group',
          nodeId: item.parentId,
          band: sign * band,
          h: expanded ? GROUP_HEADER_H : CARD_H,
          label: pLabel,
          type: (pNode?.data?.type as string) ?? 'entity',
          count: item.members.length,
          sumCount: sum,
          previewLabels: item.members.slice(0, 3).map(m => labelOf(m.nodeId, m.node)),
          unresolved: !pNode,
          expandKey: groupKey,
          expandKind: 'group',
          expanded,
          dimmed: q !== '' && memberMatches === 0 && !matches(pLabel),
          matchesInside: expanded ? 0 : memberMatches,
        }
        cards.push(gCard)
        if (!expanded) {
          // Bundled edges: one per reference node the members touch.
          const refSums = new Map<string, number>()
          for (const m of item.members) {
            for (const [refId, stat] of m.refs) {
              refSums.set(refId, (refSums.get(refId) ?? 0) + stat.count)
            }
          }
          for (const [refId, count] of refSums) {
            const refCard = placed.get(refId)
            if (refCard) addFlowEdge(dir, refCard, gCard.id, count, '', false, gCard.dimmed)
          }
        } else {
          for (const m of item.members) placeEntity(m)
        }
      }

      if (items.length > cap) {
        cards.push({
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

  return { cards, edges, hiddenByChips, bandTotals }
}

/**
 * Deterministic hop-band layout, baked into the cards in place:
 * x from the band index; y by stacking each band's cards (in insertion
 * order — the builder already sorted them) centered on the focal's
 * midline (y = 0). Group members indent by NEST_INDENT. The focal band
 * centers the FOCAL card itself on the midline and hangs the contains
 * stack below it.
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
  for (const c of cards) {
    if (c.kind !== 'frame') continue
    const kids = childrenByFrame.get(c.id) ?? []
    const inner = kids.reduce((acc, k) => acc + k.h, 0) + CARD_GAP * Math.max(0, kids.length - 1)
    c.w = CARD_W + FRAME_PAD * 2
    c.h = FRAME_HEADER_H + FRAME_PAD + Math.max(inner, kids.length === 0 ? CARD_H : 0) + FRAME_PAD
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
        c.x = c.kind === 'focal' ? x : x + NEST_INDENT
        c.y = y
        y += c.h + (c.kind === 'focal' ? CONTAINS_STACK_GAP : CARD_GAP)
      }
      continue
    }
    const nested = (c: FocusCard) => c.kind === 'entity' && isGroupMember(c, list)
    const total = list.reduce((acc, c) => acc + c.h, 0) + CARD_GAP * Math.max(0, list.length - 1)
    let y = -total / 2
    for (const c of list) {
      c.x = x + (nested(c) ? NEST_INDENT : 0)
      c.y = y
      y += c.h + CARD_GAP
    }
  }

  // Frames are positioned; now lay their children out inside them.
  const frameById = new Map(cards.filter(c => c.kind === 'frame').map(c => [c.id, c]))
  for (const [frameId, kids] of childrenByFrame) {
    const frame = frameById.get(frameId)
    if (!frame) continue
    let y = frame.y + FRAME_HEADER_H
    for (const k of kids) {
      k.x = frame.x + FRAME_PAD
      k.y = y
      y += k.h + CARD_GAP
    }
  }
}

/** A member entity rendered under its expanded group header shares the
 *  band with that header; detect it for the nested indent. */
function isGroupMember(c: FocusCard, bandList: FocusCard[]): boolean {
  if (!c.parentId) return false
  return bandList.some(o => o.kind === 'group' && o.expanded && o.nodeId === c.parentId)
}
