/**
 * Bulk links — "link these to those" in a draft: the pairs it produces, and
 * whether the ontology lets each one be drawn.
 *
 * DIRECTION is stated, never inferred. The reader holds a selection and says
 * which way the data flows — the selection feeds the entities they pick, or
 * those entities feed the selection — so N sources → 1 target, 1 source → N
 * targets and N × M all come out of one rule, and click order means nothing.
 *
 * RULES are the hand-drawn link's own: every pair goes through
 * `validateDrawnEdge` (lineage relationships only, allowed source and target
 * types, never a duplicate of a link already on the canvas; containment and
 * the platform's AGGREGATED rollup are never drawn). A pair that cannot be
 * drawn is not dropped silently — it comes back with the reason.
 */
import {
  connectedEdgeTypes,
  deriveConnectableEdges,
  validateDrawnEdge,
  type EdgeLike,
} from '@/services/ontologyPreflightService'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

/** `selection-feeds`: the selection is the source side. `feeds-selection`:
 *  the entities picked are the sources and the selection the targets. */
export type BulkDirection = 'selection-feeds' | 'feeds-selection'

export interface LinkPair {
  source: string
  target: string
}

export interface PairVerdict extends LinkPair {
  ok: boolean
  /** Why the pair cannot be drawn, in plain words. */
  reason?: string
}

export interface BulkLinkContext {
  /** An entity's type id, or null when unknown. */
  typeOf: (urn: string) => string | null
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  /** Resolves type ids to display names in the reasons. */
  entityTypes?: EntityTypeSchema[]
  /** The links already on the canvas, for duplicates. */
  existingEdges: EdgeLike[]
}

export interface BatchTypeOption {
  edgeType: string
  label: string
  description?: string
  /** How many of the batch's pairs this relationship can join. */
  fits: number
}

/** Above this many links, the reader confirms before they are staged. */
export const BULK_LINK_CONFIRM_ABOVE = 50
/** The most links one batch may stage. A draft is reviewed by a person, and
 *  N × M grows fast: 25 × 25 is already 625. */
export const BULK_LINK_MAX = 500

const pairKey = (source: string, target: string) => `${source}\u0000${target}`

/** Every pair in the direction stated — each once, never an entity to itself. */
export function expandPairs(
  selection: readonly string[],
  others: readonly string[],
  direction: BulkDirection,
): LinkPair[] {
  const seen = new Set<string>()
  const out: LinkPair[] = []
  for (const s of selection) {
    for (const o of others) {
      if (s === o) continue
      const pair = direction === 'selection-feeds' ? { source: s, target: o } : { source: o, target: s }
      const key = pairKey(pair.source, pair.target)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(pair)
    }
  }
  return out
}

/** The canvas's links, by pair — so each pair's duplicate check reads its
 *  own few links, not every link on the canvas. */
function edgesByPair(edges: readonly EdgeLike[]): Map<string, EdgeLike[]> {
  const index = new Map<string, EdgeLike[]>()
  for (const e of edges) {
    if (!e.source || !e.target) continue
    const key = pairKey(e.source, e.target)
    const list = index.get(key)
    if (list) list.push(e)
    else index.set(key, [e])
  }
  return index
}

const NONE: EdgeLike[] = []

/** Each pair through the same gate as a hand-drawn link. */
export function judgePairs(pairs: readonly LinkPair[], edgeType: string, ctx: BulkLinkContext): PairVerdict[] {
  const existing = edgesByPair(ctx.existingEdges)
  return pairs.map((p) => {
    const verdict = validateDrawnEdge({
      sourceType: ctx.typeOf(p.source),
      targetType: ctx.typeOf(p.target),
      edgeType,
      relationshipTypes: ctx.relationshipTypes,
      containmentEdgeTypes: ctx.containmentEdgeTypes,
      existingEdges: existing.get(pairKey(p.source, p.target)) ?? NONE,
      sourceId: p.source,
      targetId: p.target,
      entityTypes: ctx.entityTypes,
    })
    return verdict.allowed ? { ...p, ok: true } : { ...p, ok: false, reason: verdict.reason }
  })
}

/**
 * The relationships a batch can use: every drawable lineage type that fits at
 * least one pair (allowed between its types, not already joining it), with
 * how many it fits — most-fitting first.
 */
export function batchTypeOptions(pairs: readonly LinkPair[], ctx: BulkLinkContext): BatchTypeOption[] {
  const existing = edgesByPair(ctx.existingEdges)
  const byTypes = new Map<string, ReturnType<typeof deriveConnectableEdges>>()
  const options = new Map<string, BatchTypeOption>()
  for (const p of pairs) {
    const sType = ctx.typeOf(p.source)
    const tType = ctx.typeOf(p.target)
    const typesKey = `${sType ?? ''}\u0000${tType ?? ''}`
    let allowed = byTypes.get(typesKey)
    if (!allowed) {
      allowed = deriveConnectableEdges(sType, tType, ctx.relationshipTypes, ctx.containmentEdgeTypes, ctx.entityTypes)
      byTypes.set(typesKey, allowed)
    }
    const joined = connectedEdgeTypes(existing.get(pairKey(p.source, p.target)) ?? NONE, p.source, p.target)
    for (const o of allowed) {
      if (!o.allowed || joined.has(o.edgeType.toUpperCase())) continue
      const option = options.get(o.edgeType)
      if (option) option.fits++
      else options.set(o.edgeType, { edgeType: o.edgeType, label: o.label, description: o.description, fits: 1 })
    }
  }
  return [...options.values()].sort((a, b) => b.fits - a.fits || a.label.localeCompare(b.label))
}

/** Whether a pair's TYPES admit any drawable lineage relationship, and if
 *  not, why — memoised per (source type, target type), so checking every
 *  entity on the canvas against the selection stays cheap. Duplicates are
 *  the review's business, not this. */
export type FitChecker = (source: string, target: string) => { ok: boolean; reason?: string }

export function makeFitChecker(ctx: Omit<BulkLinkContext, 'existingEdges'>): FitChecker {
  const memo = new Map<string, { ok: boolean; reason?: string }>()
  return (source, target) => {
    const sType = ctx.typeOf(source)
    const tType = ctx.typeOf(target)
    const key = `${sType ?? ''}\u0000${tType ?? ''}`
    let hit = memo.get(key)
    if (!hit) {
      const options = deriveConnectableEdges(sType, tType, ctx.relationshipTypes, ctx.containmentEdgeTypes, ctx.entityTypes)
      hit = options.some((o) => o.allowed)
        ? { ok: true }
        : { ok: false, reason: options.find((o) => o.reason)?.reason ?? 'No lineage relationship in the ontology joins these types.' }
      memo.set(key, hit)
    }
    return hit
  }
}

/** How many of the selection a candidate for the other side could be linked
 *  with, in the direction given — and, when none, why. */
export function candidateFit(
  candidate: string,
  selection: readonly string[],
  direction: BulkDirection,
  fit: FitChecker,
): { fits: number; reason?: string } {
  let fits = 0
  let reason: string | undefined
  for (const s of selection) {
    if (s === candidate) continue
    const v = direction === 'selection-feeds' ? fit(s, candidate) : fit(candidate, s)
    if (v.ok) fits++
    else reason ??= v.reason
  }
  return fits > 0 ? { fits } : { fits, reason }
}

export interface DropVerdict {
  /** Every pair links / some do / none do — the hovered card's ring. */
  level: 'all' | 'some' | 'none'
  /** Links the best relationship would add. */
  count: number
  /** One line for the cursor. */
  text: string
}

/** What dropping here would do: the best-fitting relationship across every
 *  source → target pair, and how much of the batch it covers. */
export function dropVerdict(sources: readonly string[], targets: readonly string[], ctx: BulkLinkContext): DropVerdict {
  const pairs: LinkPair[] = []
  for (const s of sources) for (const t of targets) if (s !== t) pairs.push({ source: s, target: t })
  if (pairs.length === 0) return { level: 'none', count: 0, text: 'Nothing to link here.' }
  const [best] = batchTypeOptions(pairs, ctx)
  if (!best) {
    const reason = makeFitChecker(ctx)(pairs[0].source, pairs[0].target).reason
    return { level: 'none', count: 0, text: reason ?? 'These are already linked.' }
  }
  const noun = (n: number) => (n === 1 ? 'link' : 'links')
  return best.fits === pairs.length
    ? { level: 'all', count: best.fits, text: `${best.fits} ${noun(best.fits)} · ${best.label}` }
    : { level: 'some', count: best.fits, text: `${best.fits} of ${pairs.length} can link · ${best.label}` }
}
