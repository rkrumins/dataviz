/**
 * Case-fold helpers — the frontend half of the ontology's canonical case-insensitive
 * contract (see backend `resolver.case_insensitive_type_id_collisions` and
 * `_group_stats_by_casefold`). `To`, `to`, and `TO` are the SAME ontology type; FalkorDB is
 * case-sensitive, so those physical spellings coexist in the graph and are folded to one
 * canonical declared id for display, categorization, and save.
 *
 * Reuses the `MergedVariantSpelling` shape already emitted by the suggest/onboarding flow so the
 * Schema page's "also seen as" badge, the Suggest dialog, and the Health case-drift view all speak
 * the same vocabulary.
 */
import type { MergedVariantSpelling } from '@/services/ontologyDefinitionService'
import type { EdgeTypeSummary, EntityTypeSummary } from '@/providers/GraphDataProvider'
import type { EntityTypeSchema } from '@/types/schema'
import type { RelTypeWithClassifications } from './ontology-types'

/** The identity under which `To`/`to`/`TO` are the same type. */
export const caseFold = (id: string): string => (id ?? '').trim().toLowerCase()

/**
 * Pick the canonical spelling for a case-fold group. Mirrors backend `_canonical_stat_id`:
 * a spelling the graph actually uses wins (so live edges resolve without leaning on the alias
 * map), then the highest instance count, then first-seen (stable-sort tiebreak).
 */
export function pickCanonicalSpelling(
  spellings: Array<{ spelling: string; count: number }>,
  preferred?: ReadonlySet<string>,
): string {
  if (spellings.length === 0) return ''
  if (preferred && preferred.size > 0) {
    const hit = spellings.find((s) => preferred.has(s.spelling))
    if (hit) return hit.spelling
  }
  // Stable sort by count desc; equal counts keep first-seen order.
  return [...spellings].sort((a, b) => b.count - a.count)[0].spelling
}

/** One case-fold group of physically-observed graph edges: summed count, every spelling, and the
 *  union of observed source/target labels. Built from the RAW stat list (not the lossy
 *  lowercased map) so a graph that spells a type several ways keeps all spellings + a correct total. */
export interface FoldedGraphEdge {
  total: number
  spellings: MergedVariantSpelling[]
  sourceTypes: string[]
  targetTypes: string[]
}

/** Fold `edgeTypeStats` by case-fold, summing counts and preserving each observed physical spelling. */
export function foldEdgeStats(stats: EdgeTypeSummary[]): Map<string, FoldedGraphEdge> {
  const out = new Map<string, FoldedGraphEdge>()
  for (const s of stats ?? []) {
    const key = caseFold(s.id)
    if (!key) continue
    const entry = out.get(key) ?? { total: 0, spellings: [], sourceTypes: [], targetTypes: [] }
    const count = Number(s.count ?? 0)
    entry.total += count
    const existing = entry.spellings.find((v) => v.spelling === s.id)
    if (existing) existing.count += count
    else entry.spellings.push({ spelling: s.id, count })
    for (const st of s.sourceTypes ?? []) if (!entry.sourceTypes.includes(st)) entry.sourceTypes.push(st)
    for (const tt of s.targetTypes ?? []) if (!entry.targetTypes.includes(tt)) entry.targetTypes.push(tt)
    out.set(key, entry)
  }
  return out
}

/**
 * Build the merged-variants list for one declared type: every distinct spelling (declared
 * duplicates + physical graph spellings) with its graph count, canonical spelling first. Returns
 * `null` when the type is spelled exactly one way (no badge needed).
 *
 * The shape matches `MergedVariantsAdvisory`, which renders the first entry (canonical) green and
 * the rest amber/strikethrough.
 */
export function mergedVariantsFor(
  canonicalId: string,
  declaredSpellings: string[],
  graphEdge?: FoldedGraphEdge,
): MergedVariantSpelling[] | null {
  const counts = new Map<string, number>()
  const order: string[] = []
  const add = (spelling: string, count: number) => {
    if (!spelling) return
    if (!counts.has(spelling)) order.push(spelling)
    counts.set(spelling, (counts.get(spelling) ?? 0) + count)
  }
  add(canonicalId, 0)
  for (const s of declaredSpellings) add(s, 0)
  for (const v of graphEdge?.spellings ?? []) add(v.spelling, v.count)

  const distinct = order.filter((s) => caseFold(s) === caseFold(canonicalId))
  if (distinct.length <= 1) return null
  // Canonical first, then the rest in first-seen order.
  const rest = distinct.filter((s) => s !== canonicalId)
  return [canonicalId, ...rest].map((spelling) => ({ spelling, count: counts.get(spelling) ?? 0 }))
}

/** A case-fold group of simple id/count stats (entities): summed count + every spelling. */
export interface FoldedSimpleStat {
  total: number
  spellings: MergedVariantSpelling[]
}

export function foldSimpleStats(stats: EntityTypeSummary[]): Map<string, FoldedSimpleStat> {
  const out = new Map<string, FoldedSimpleStat>()
  for (const s of stats ?? []) {
    const key = caseFold(s.id)
    if (!key) continue
    const entry = out.get(key) ?? { total: 0, spellings: [] }
    const count = Number(s.count ?? 0)
    entry.total += count
    const existing = entry.spellings.find((v) => v.spelling === s.id)
    if (existing) existing.count += count
    else entry.spellings.push({ spelling: s.id, count })
    out.set(key, entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// Row folding for the Schema page — one canonical row per case-fold group, with
// the merged spellings surfaced for the "also seen as" badge.
// ---------------------------------------------------------------------------

export interface FoldedRelRows {
  rows: RelTypeWithClassifications[]
  /** canonical row id -> merged spellings (canonical first); present only when spelled >1 way. */
  variantsById: Map<string, MergedVariantSpelling[]>
  /** canonical row id -> summed graph count across all physical spellings. */
  graphCountById: Map<string, number>
  /** canonical row id -> observed source/target labels (union across spellings). */
  graphEndpointsById: Map<string, { sourceTypes: string[]; targetTypes: string[] }>
}

export function foldRelTypeRows(
  rows: RelTypeWithClassifications[],
  edgeFold: Map<string, FoldedGraphEdge>,
): FoldedRelRows {
  const groups = new Map<string, RelTypeWithClassifications[]>()
  for (const r of rows) {
    const k = caseFold(r.id)
    const g = groups.get(k) ?? []
    g.push(r)
    groups.set(k, g)
  }

  const outRows: RelTypeWithClassifications[] = []
  const variantsById = new Map<string, MergedVariantSpelling[]>()
  const graphCountById = new Map<string, number>()
  const graphEndpointsById = new Map<string, { sourceTypes: string[]; targetTypes: string[] }>()

  for (const [key, group] of groups) {
    const graphEdge = edgeFold.get(key)
    const physical = new Set((graphEdge?.spellings ?? []).map((s) => s.spelling))
    const canonicalId =
      pickCanonicalSpelling(
        group.map((r) => ({
          spelling: r.id,
          count: graphEdge?.spellings.find((s) => s.spelling === r.id)?.count ?? 0,
        })),
        physical,
      ) || group[0].id
    const primary = group.find((r) => r.id === canonicalId) ?? group[0]
    outRows.push({
      ...primary,
      id: canonicalId,
      // Union classification across the folded variants — if any spelling was categorized, the
      // canonical row is categorized (the backend `_sync_classification` reconciles the same way).
      isContainment: group.some((r) => r.isContainment),
      isLineage: group.some((r) => r.isLineage),
      // Only read-only if EVERY folded spelling is a built-in; a user spelling makes it editable.
      isSystem: group.every((r) => r.isSystem),
    })
    const variants = mergedVariantsFor(canonicalId, group.map((r) => r.id), graphEdge)
    if (variants) variantsById.set(canonicalId, variants)
    if (graphEdge) {
      graphCountById.set(canonicalId, graphEdge.total)
      graphEndpointsById.set(canonicalId, {
        sourceTypes: graphEdge.sourceTypes,
        targetTypes: graphEdge.targetTypes,
      })
    }
  }

  outRows.sort((a, b) => a.name.localeCompare(b.name))
  return { rows: outRows, variantsById, graphCountById, graphEndpointsById }
}

export interface FoldedEntityRows {
  rows: EntityTypeSchema[]
  variantsById: Map<string, MergedVariantSpelling[]>
  graphCountById: Map<string, number>
}

export function foldEntityTypeRows(
  rows: EntityTypeSchema[],
  statFold: Map<string, FoldedSimpleStat>,
): FoldedEntityRows {
  const groups = new Map<string, EntityTypeSchema[]>()
  for (const e of rows) {
    const k = caseFold(e.id)
    const g = groups.get(k) ?? []
    g.push(e)
    groups.set(k, g)
  }

  const outRows: EntityTypeSchema[] = []
  const variantsById = new Map<string, MergedVariantSpelling[]>()
  const graphCountById = new Map<string, number>()

  for (const [key, group] of groups) {
    const stat = statFold.get(key)
    const physical = new Set((stat?.spellings ?? []).map((s) => s.spelling))
    const canonicalId =
      pickCanonicalSpelling(
        group.map((e) => ({
          spelling: e.id,
          count: stat?.spellings.find((s) => s.spelling === e.id)?.count ?? 0,
        })),
        physical,
      ) || group[0].id
    const primary = group.find((e) => e.id === canonicalId) ?? group[0]
    outRows.push({ ...primary, id: canonicalId })
    const variants = mergedVariantsFor(canonicalId, group.map((e) => e.id), stat && {
      total: stat.total,
      spellings: stat.spellings,
      sourceTypes: [],
      targetTypes: [],
    })
    if (variants) variantsById.set(canonicalId, variants)
    if (stat) graphCountById.set(canonicalId, stat.total)
  }

  outRows.sort((a, b) => a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name))
  return { rows: outRows, variantsById, graphCountById }
}

// ---------------------------------------------------------------------------
// Save-time canonicalization — collapse case-variant DECLARED keys to one canonical
// key so the payload never trips the backend's `case_insensitive_type_id_collisions`
// guard (which 422s on two declared ids that differ only by case). This is the
// client half of the fold; the backend repair (Phase 2) fixes data at rest.
// ---------------------------------------------------------------------------

function mergeNote(description: unknown, folded: string[]): string | undefined {
  if (folded.length === 0) return typeof description === 'string' ? description : undefined
  const note = `also seen as: ${folded.join(', ')}`
  const desc = typeof description === 'string' && description ? description : ''
  if (desc.includes(note)) return desc
  return desc ? `${desc} (${note})` : note
}

export interface CanonicalizedRelDefs {
  relDefs: Record<string, unknown>
  containment: string[]
  lineage: string[]
  /** canonical id -> the off-spellings folded into it (empty when nothing merged). */
  merged: Record<string, string[]>
}

export function canonicalizeRelDefsForSave(
  relDefs: Record<string, unknown>,
  containment: string[],
  lineage: string[],
  edgeFold?: Map<string, FoldedGraphEdge>,
): CanonicalizedRelDefs {
  const groups = new Map<string, string[]>()
  for (const k of Object.keys(relDefs)) {
    const cf = caseFold(k)
    const g = groups.get(cf) ?? []
    g.push(k)
    groups.set(cf, g)
  }

  const canonicalOf = new Map<string, string>()
  const outDefs: Record<string, unknown> = {}
  const merged: Record<string, string[]> = {}

  for (const [cf, keys] of groups) {
    const graphEdge = edgeFold?.get(cf)
    const physical = new Set((graphEdge?.spellings ?? []).map((s) => s.spelling))
    const canonical =
      pickCanonicalSpelling(
        keys.map((k) => ({
          spelling: k,
          count: graphEdge?.spellings.find((s) => s.spelling === k)?.count ?? 0,
        })),
        physical,
      ) || keys[0]
    canonicalOf.set(cf, canonical)

    const base: Record<string, unknown> = { ...(relDefs[canonical] as Record<string, unknown>) }
    let isC = !!base.is_containment
    let isL = !!base.is_lineage
    const foldedSpellings: string[] = []
    for (const k of keys) {
      if (k === canonical) continue
      const d = (relDefs[k] as Record<string, unknown>) ?? {}
      isC = isC || !!d.is_containment
      isL = isL || !!d.is_lineage
      foldedSpellings.push(k)
    }
    base.is_containment = isC
    base.is_lineage = isL
    if (foldedSpellings.length > 0) {
      base.description = mergeNote(base.description, foldedSpellings)
      merged[canonical] = foldedSpellings
    }
    outDefs[canonical] = base
  }

  const remap = (list: string[]): string[] => {
    const out: string[] = []
    for (const t of list ?? []) {
      const canonical = canonicalOf.get(caseFold(t)) ?? t
      if (!out.includes(canonical)) out.push(canonical)
    }
    return out
  }

  return { relDefs: outDefs, containment: remap(containment), lineage: remap(lineage), merged }
}

/**
 * Fold case-variant type-id keys in an ontology WRITE request so the payload can never trip the
 * backend's case-insensitive collision guard (`case_insensitive_type_id_collisions`, which 422s on
 * two declared ids differing only by case — e.g. `Has`+`HAS`). Operates on the request shape
 * (camelCase `relationshipTypeDefinitions` / `entityTypeDefinitions` / `containmentEdgeTypes` /
 * `lineageEdgeTypes`); a NO-OP when those keys are absent or already canonical, so it is safe to run
 * on every create/update/import from the shared service layer. Idempotent — re-folding an already
 * canonical payload changes nothing.
 */
export function foldRequestTypeDefs<T extends Record<string, unknown>>(req: T): T {
  if (!req || typeof req !== 'object') return req
  const out: Record<string, unknown> = { ...req }

  const relDefs = out.relationshipTypeDefinitions
  if (relDefs && typeof relDefs === 'object') {
    const canon = canonicalizeRelDefsForSave(
      relDefs as Record<string, unknown>,
      (out.containmentEdgeTypes as string[]) ?? [],
      (out.lineageEdgeTypes as string[]) ?? [],
    )
    out.relationshipTypeDefinitions = canon.relDefs
    // Only rewrite the lists that were actually part of the request — never add an empty list that
    // would wipe the server's existing containment/lineage on a partial update.
    if (out.containmentEdgeTypes !== undefined) out.containmentEdgeTypes = canon.containment
    if (out.lineageEdgeTypes !== undefined) out.lineageEdgeTypes = canon.lineage
  }

  const entityDefs = out.entityTypeDefinitions
  if (entityDefs && typeof entityDefs === 'object') {
    out.entityTypeDefinitions = canonicalizeEntityDefsForSave(entityDefs as Record<string, unknown>).entityDefs
  }

  return out as T
}

export interface CanonicalizedEntityDefs {
  entityDefs: Record<string, unknown>
  merged: Record<string, string[]>
}

/** Collapse case-variant entity keys and rewrite hierarchy references (can_contain /
 *  can_be_contained_by) to the surviving canonical key. */
export function canonicalizeEntityDefsForSave(
  entityDefs: Record<string, unknown>,
  statFold?: Map<string, FoldedSimpleStat>,
): CanonicalizedEntityDefs {
  const groups = new Map<string, string[]>()
  for (const k of Object.keys(entityDefs)) {
    const cf = caseFold(k)
    const g = groups.get(cf) ?? []
    g.push(k)
    groups.set(cf, g)
  }

  const canonicalOf = new Map<string, string>()
  for (const [cf, keys] of groups) {
    const stat = statFold?.get(cf)
    const physical = new Set((stat?.spellings ?? []).map((s) => s.spelling))
    const canonical =
      pickCanonicalSpelling(
        keys.map((k) => ({
          spelling: k,
          count: stat?.spellings.find((s) => s.spelling === k)?.count ?? 0,
        })),
        physical,
      ) || keys[0]
    canonicalOf.set(cf, canonical)
  }

  const remapRef = (id: string): string => canonicalOf.get(caseFold(id)) ?? id
  const remapList = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list
    const out: string[] = []
    for (const v of list) {
      const c = remapRef(String(v))
      if (!out.includes(c)) out.push(c)
    }
    return out
  }

  const outDefs: Record<string, unknown> = {}
  const merged: Record<string, string[]> = {}

  for (const [cf, keys] of groups) {
    const canonical = canonicalOf.get(cf) as string
    const base: Record<string, unknown> = { ...(entityDefs[canonical] as Record<string, unknown>) }
    const hier = { ...((base.hierarchy as Record<string, unknown>) ?? {}) }
    if (hier.can_contain) hier.can_contain = remapList(hier.can_contain)
    if (hier.can_be_contained_by) hier.can_be_contained_by = remapList(hier.can_be_contained_by)
    base.hierarchy = hier
    const folded = keys.filter((k) => k !== canonical)
    if (folded.length > 0) {
      base.description = mergeNote(base.description, folded)
      merged[canonical] = folded
    }
    outDefs[canonical] = base
  }

  return { entityDefs: outDefs, merged }
}
