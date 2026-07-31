/**
 * focus-graph — pure builder for the Lens's interactive Graph mode.
 *
 * Turns the focal node's neighbor records (plus any expanded hops) into
 * positioned cards and edges for a DataHub-style hop-band layout:
 * focal at band 0, direct upstream at band -1, downstream at +1, and
 * user-expanded hops at ±2..±MAX_BAND. Everything here is deliberately
 * framework-free (no React, no React Flow) so the entire graph
 * semantics — grouping, rollups, drills, frontier expansion, caps,
 * filters, layout — is unit-testable in plain functions.
 *
 * Honesty rules carried over from the list body:
 *  - band caps surface as an explicit "+N more" overflow card and
 *    per-band shown/total counts — never silent truncation;
 *  - the text filter DIMS non-matching cards (and reports matches
 *    hidden inside collapsed groups) — it never removes them;
 *  - type chips REMOVE cards but the removed count is reported;
 *  - a drilled aggregate reports its unloaded remainder, and grouping
 *    is derived from real lineage records only — children that don't
 *    participate in lineage never appear.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { deriveNeighborRecords, type NeighborRecord } from '@/lib/lineage-neighbors'

/** Cards per band before the "+N more" overflow card (paged). */
export const GRAPH_BAND_CAP = 30
/** Focal containment children shown before the overflow card. */
export const CONTAINS_CAP = 8
/** Hard stop for hop expansion per direction. */
export const MAX_BAND = 4

export const CARD_W = 240
export const FOCAL_H = 96
export const CARD_H = 64
export const GROUP_HEADER_H = 40
export const CONTAINS_H = 36
export const OVERFLOW_H = 36
export const CONSTITUENT_H = 44
export const BAND_GAP = 130
export const CARD_GAP = 10
/** Indent for cards nested under a header (group members, constituents). */
export const NEST_INDENT = 16
/** Vertical gap between the focal card and its contains stack. */
export const CONTAINS_STACK_GAP = 18

export type FocusDirection = 'in' | 'out'

export type FocusCardKind = 'focal' | 'entity' | 'group' | 'contains' | 'overflow'

export interface FocusCard {
  /** Stable across rebuilds so shared cards glide between focal swaps:
   *  'f' | n:urn | g:dir:parentUrn | c:urn | x:edgeId:urn | more:dir:band */
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
  /** Entity type id; 'entity' fallback, 'not loaded' when unresolved. */
  type: string
  parentId: string | null
  parentLabel: string | null
  /** Entity: bundled connection count (≥1). Group: member count. */
  count: number
  /** Group: Σ member connection counts. 0 elsewhere. */
  sumCount: number
  /** Coarser-grain summary of finer flows (dashed, badged, demoted). */
  rollup: boolean
  /** Entity not resolvable from store or fetches ("not on canvas"). */
  unresolved: boolean
  aggregated: boolean
  aggregateEdge: LineageEdge | null
  /** Key into drilledRows when the ×N badge can drill; null otherwise. */
  drillKey: string | null
  /** Group toggle key into expandedGroups / frontier key into
   *  expandedFrontier; null when the card has no expansion. */
  expandKey: string | null
  /** True when this group card is currently expanded (header form). */
  expanded: boolean
  /** Card can fetch-and-reveal its own next hop (the ⊕ pill side). */
  frontier: boolean
  /** True when this card's next hop is already expanded. */
  frontierExpanded: boolean
  degreeHint: { in: number; out: number } | null
  fetch: 'loading' | 'error' | null
  /** Text-filter miss — rendered dimmed, never removed. */
  dimmed: boolean
  /** Collapsed group only: members matching the text filter. */
  matchesInside: number
  /** Overflow card only: how many more cards the band holds. */
  overflowCount: number
  /** Drilled aggregate: constituents not loaded (reported, not invented). */
  missingConstituents: number
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
  drilledRows: ReadonlySet<string>
  drillEdges?: Map<string, LineageEdge[]>
  rawEdgeById: Map<string, LineageEdge>
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
  aggregateEdge: LineageEdge | null
  canDrill: boolean
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

const canDrillEdge = (e: LineageEdge): boolean => {
  const d = e.data as { isAggregated?: boolean; sourceEdgeCount?: number; sourceEdges?: string[] } | undefined
  return !!d?.isAggregated && ((d.sourceEdges?.length ?? 0) > 0 || (d.sourceEdgeCount ?? 0) > 1)
}

export function buildFocusGraph(input: FocusGraphInput): FocusGraph {
  const {
    focalId, incomingRecords, outgoingRecords, edgesByEndpoint, nodeMap,
    containmentEdgeTypes, containsChildren, containsTotal, resolveParent,
    isCoarser, expandedGroups, expandedFrontier, drilledRows, drillEdges,
    rawEdgeById, bandPages, query, hiddenTypes, degreeHints, fetchStatus,
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
    parentId: null, parentLabel: null,
    count: 1, sumCount: 0,
    rollup: false, unresolved: false,
    aggregated: false, aggregateEdge: null,
    drillKey: null, expandKey: null, expanded: false,
    frontier: false, frontierExpanded: false,
    degreeHint: null, fetch: null,
    dimmed: false, matchesInside: 0,
    overflowCount: 0, missingConstituents: 0,
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

  const containsCap = CONTAINS_CAP * (1 + (bandPages.get('contains') ?? 0))
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
      label: `+${(containsTotalAll - containsShown.length).toLocaleString()} more contained`,
      type: 'entity',
      expandKey: 'contains',
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
      // Collect this band's records from every reference node.
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
              agg: { aggregated: false, aggregateEdge: null, canDrill: false },
              rollup: isCoarser(r.neighborNode?.data?.type as string | undefined, ref.type),
              refs: new Map(),
            }
            entryMap.set(r.neighborId, entry)
          }
          entry.count += n
          if (aggData?.isAggregated && !entry.agg.aggregateEdge) {
            entry.agg = {
              aggregated: true,
              aggregateEdge: r.edge,
              canDrill: canDrillEdge(r.edge),
            }
          }
          const refStat = entry.refs.get(ref.nodeId)
          if (refStat) refStat.count += n
          else entry.refs.set(ref.nodeId, { count: n, edgeTypeNorm: r.edgeTypeNorm, aggregated: !!aggData?.isAggregated })
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
        const drillKey = entry.agg.canDrill && entry.agg.aggregateEdge ? `g:${dir}:${entry.agg.aggregateEdge.id}` : null
        const card: FocusCard = {
          ...baseCard(),
          id: `n:${entry.nodeId}`,
          kind: 'entity',
          nodeId: entry.nodeId,
          band: sign * band,
          label,
          type,
          parentId,
          parentLabel: parentId ? labelOf(parentId, nodeMap.get(parentId)) : null,
          count: entry.count,
          rollup: entry.rollup,
          unresolved: !entry.node,
          aggregated: entry.agg.aggregated,
          aggregateEdge: entry.agg.aggregateEdge,
          drillKey,
          expandKey: frontierKey,
          // Any entity card can walk its own next hop until the hard
          // band stop — except rollups (they summarize flows already
          // shown at finer grain) and nodes whose KNOWN outward degree
          // is zero (nothing to fetch; absent hint ≠ zero).
          frontier: !isOutermost && !entry.rollup
            && (degreeHints?.get(entry.nodeId)?.[dir] ?? -1) !== 0,
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

        // Drilled aggregate → constituent cards (local ∪ fetched raw
        // edges), each tethered to this card; remainder reported.
        if (drillKey && drilledRows.has(drillKey) && entry.agg.aggregateEdge) {
          const aggEdge = entry.agg.aggregateEdge
          const aggData = aggEdge.data as { sourceEdgeCount?: number; sourceEdges?: string[] } | undefined
          const local = (aggData?.sourceEdges ?? [])
            .map(eid => rawEdgeById.get(eid))
            .filter((e): e is LineageEdge => !!e)
          const seen = new Set(local.map(e => e.id))
          const fetched = (drillEdges?.get(aggEdge.id) ?? []).filter(e => !seen.has(e.id))
          const all = [...local, ...fetched]
          const constituents = all.slice(0, 50)
          card.missingConstituents = Math.max(0, Math.max(aggData?.sourceEdgeCount ?? 0, all.length) - constituents.length)
          for (const ce of constituents) {
            const otherId = dir === 'in' ? ce.source : ce.target
            if (otherId === entry.nodeId) continue
            const ceType = ((ce.data?.edgeType as string) ?? '').toUpperCase()
            if (placed.has(otherId)) {
              // Fine endpoint already on the board — tether, don't dupe.
              addFlowEdge(dir, card.id, placed.get(otherId)!, 1, ceType, false, card.dimmed)
              continue
            }
            const oNode = nodeMap.get(otherId)
            const oLabel = labelOf(otherId, oNode)
            const cCard: FocusCard = {
              ...baseCard(),
              id: `x:${aggEdge.id}:${otherId}`,
              kind: 'entity',
              nodeId: otherId,
              band: sign * band,
              h: CONSTITUENT_H,
              label: oLabel,
              type: (oNode?.data?.type as string) ?? 'not loaded',
              parentId: entry.nodeId,
              parentLabel: label,
              unresolved: !oNode,
              dimmed: !matches(oLabel),
            }
            placed.set(otherId, cCard.id)
            cards.push(cCard)
            edges.push({
              id: `fe:${cCard.id}~${card.id}`,
              source: dir === 'in' ? cCard.id : card.id,
              target: dir === 'in' ? card.id : cCard.id,
              count: 1,
              edgeTypeNorm: ceType,
              aggregated: false,
              containment: false,
              dimmed: cCard.dimmed,
            })
          }
        }
        return card
      }

      for (const item of shown) {
        if (item.kind === 'entity') {
          placeEntity(item.entry)
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
          unresolved: !pNode,
          expandKey: groupKey,
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
 * midline (y = 0). Nested cards (group members, drill constituents)
 * indent by NEST_INDENT. The focal band centers the FOCAL card itself
 * on the midline and hangs the contains stack below it.
 */
function layoutBands(cards: FocusCard[]) {
  const byBand = new Map<number, FocusCard[]>()
  for (const c of cards) {
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
    const nested = (c: FocusCard) => c.id.startsWith('x:') || (c.kind === 'entity' && isGroupMember(c, list))
    const total = list.reduce((acc, c) => acc + c.h, 0) + CARD_GAP * Math.max(0, list.length - 1)
    let y = -total / 2
    for (const c of list) {
      c.x = x + (nested(c) ? NEST_INDENT : 0)
      c.y = y
      y += c.h + CARD_GAP
    }
  }
}

/** A member entity rendered under its expanded group header shares the
 *  band with that header; detect it for the nested indent. */
function isGroupMember(c: FocusCard, bandList: FocusCard[]): boolean {
  if (!c.parentId) return false
  return bandList.some(o => o.kind === 'group' && o.expanded && o.nodeId === c.parentId)
}
