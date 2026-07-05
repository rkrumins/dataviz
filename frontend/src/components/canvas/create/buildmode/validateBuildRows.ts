/**
 * validateBuildRows — pure auto-fix pass over an in-progress BuildRow[]:
 * infers missing types, auto-promotes leaf-typed parents that gained a child
 * they can't yet contain, inserts missing intermediate parent levels, and
 * marks every row valid/fixed/error with plain-language issues. No
 * store/React imports — ontology context is passed in explicitly so this is
 * unit-testable without mocks.
 */
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import {
  allowedChildTypeIds,
  builderAllowedChildTypeIds,
  containmentChains,
  planRetype,
  setHasId,
} from '@/services/ontologyPreflightService'
import type { RetypeContext, RetypeNode } from '@/services/ontologyPreflightService'
import { type BuildRow, childrenOf as rowChildrenOf, makeRow, reindexDepths } from './buildRow'

export interface BuildOntologyCtx {
  entityTypes: EntityTypeSchema[]
  rootEntityTypes: string[]
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
}

export interface BuildValidationSummary {
  valid: number
  fixed: number
  errors: number
}

export function summarize(rows: BuildRow[]): BuildValidationSummary {
  return rows.reduce(
    (acc, r) => {
      if (r.status === 'valid') acc.valid++
      else if (r.status === 'fixed') acc.fixed++
      else acc.errors++
      return acc
    },
    { valid: 0, fixed: 0, errors: 0 },
  )
}

// ontologyPreflightService's `sameId`/`findEntityType` aren't exported — small
// local equivalents rather than widening that file's public surface for this
// (otherwise unrelated) pure module.
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function findType(id: string | null, entityTypes: EntityTypeSchema[]): EntityTypeSchema | undefined {
  if (id == null) return undefined
  return entityTypes.find((t) => t.id === id) ?? entityTypes.find((t) => sameId(t.id, id))
}

function displayName(id: string | null, entityTypes: EntityTypeSchema[]): string {
  if (id == null) return '(root)'
  return findType(id, entityTypes)?.name ?? id
}

function article(name: string): 'a' | 'an' {
  return /^[aeiou]/i.test(name) ? 'an' : 'a'
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

function sortByLevelThenName(ids: string[], entityTypes: EntityTypeSchema[]): string[] {
  return [...ids].sort((a, b) => {
    const ea = findType(a, entityTypes)
    const eb = findType(b, entityTypes)
    const levelDiff = (ea?.hierarchy.level ?? 0) - (eb?.hierarchy.level ?? 0)
    return levelDiff !== 0 ? levelDiff : (ea?.name ?? a).localeCompare(eb?.name ?? b)
  })
}

/** Case-insensitive lookup of a type's declared `canBeContainedBy` (schema first, then hierarchyMap); `undefined` when the type is unknown to both (fail-open). */
function childCanBeContainedBy(childType: string, ctx: BuildOntologyCtx): string[] | undefined {
  const fromSchema = findType(childType, ctx.entityTypes)?.hierarchy.canBeContainedBy
  if (fromSchema) return fromSchema
  const key = childType in ctx.hierarchyMap ? childType : Object.keys(ctx.hierarchyMap).find((k) => sameId(k, childType))
  return key ? ctx.hierarchyMap[key].canBeContainedBy : undefined
}

/**
 * A DECLARED root type — membership in `ctx.rootEntityTypes` (case-insensitive), legal ONLY at the top level,
 * never as anyone's child. This is NOT "has an empty `canBeContainedBy`": per the backend authority
 * (mutation_validator.py:156-157), an empty `canBeContainedBy` means UNRESTRICTED (any parent), not root-only —
 * only explicit membership in the declared roots list makes a type root-only. In the real system the two signals
 * never conflict (resolver.py derives `root_entity_types` as `not can_be_contained_by`), but a type can be BOTH a
 * declared root AND separately declare a non-empty `canBeContainedBy` for self-nesting (e.g. `group`), so
 * `rootEntityTypes` membership — not the emptiness of `canBeContainedBy` — is the authoritative root signal here.
 */
function isRootOnlyType(typeId: string, ctx: BuildOntologyCtx): boolean {
  return ctx.rootEntityTypes.some((r) => sameId(r, typeId))
}

/**
 * THE authoritative "may `childType` be created directly under `parentType` (or at the top level when
 * `parentType` is null)?" predicate. ANDs two independent gates so illegal nesting can never slip through:
 *  - membership: `childType` must be one of the parent's legal children per the ontology —
 *    {@link builderAllowedChildTypeIds}'s combined canContain + containment-relationship-legality gate (which
 *    already also implies the LEAF guard: a parent closed to nesting has an empty legal-children set) — or, at
 *    the top level, one of the declared root types ({@link allowedChildTypeIds} with `parentType` null).
 *  - the child's OWN `canBeContainedBy`:
 *     - non-empty: an explicit allow-list that WINS regardless of root status — legal iff `parentType` is in it
 *       (a type can be both a declared root and self-nestable, e.g. `group` with `canBeContainedBy: ['group']`).
 *     - empty: UNRESTRICTED per the backend authority (mutation_validator.py:156-157) — legal under any parent
 *       that can contain it — UNLESS `childType` is a declared root ({@link isRootOnlyType}), which can never be
 *       legally nested under anyone.
 */
export function isLegalChild(parentType: string | null, childType: string, ctx: BuildOntologyCtx): boolean {
  if (parentType == null) {
    return setHasId(allowedChildTypeIds(null, ctx.entityTypes, ctx.rootEntityTypes, ctx.hierarchyMap), childType)
  }
  const legalChildren = builderAllowedChildTypeIds(
    parentType,
    ctx.entityTypes,
    ctx.rootEntityTypes,
    ctx.hierarchyMap,
    ctx.relationshipTypes,
    ctx.containmentEdgeTypes,
  )
  if (!setHasId(legalChildren, childType)) return false
  const canBeContainedBy = childCanBeContainedBy(childType, ctx)
  if (canBeContainedBy == null) return true // unknown type: fail open, consistent with the rest of this module
  if (canBeContainedBy.length === 0) return !isRootOnlyType(childType, ctx) // empty = unrestricted, unless a declared root
  return canBeContainedBy.some((p) => sameId(p, parentType)) // non-empty: explicit allow-list wins regardless of root
}

function buildRetypeCtx(byId: Map<string, BuildRow>, ctx: BuildOntologyCtx): RetypeContext {
  return {
    entityTypes: ctx.entityTypes,
    relationshipTypes: ctx.relationshipTypes,
    containmentEdgeTypes: ctx.containmentEdgeTypes,
    parentTypeOf: (nodeId) => {
      const row = byId.get(nodeId)
      const parent = row?.parentId != null ? byId.get(row.parentId) : undefined
      return parent?.typeId ?? null
    },
    childrenOf: (nodeId) =>
      rowChildrenOf([...byId.values()], nodeId).map((r) => ({ id: r.id, urn: r.id, name: r.name, type: r.typeId ?? '' })),
    incidentLineageEdges: () => [], // BuildRow doesn't model lineage edges pre-save
  }
}

/** Tries to retype `parentRow` to something that still fits ITS OWN parent and can contain `childTypeId`. */
function tryAutoPromoteParent(
  parentRow: BuildRow,
  childTypeId: string,
  byId: Map<string, BuildRow>,
  ctx: BuildOntologyCtx,
): boolean {
  if (parentRow.typeId == null) return false
  const grandparentType = parentRow.parentId != null ? (byId.get(parentRow.parentId)?.typeId ?? null) : null
  const candidates = sortByLevelThenName(
    ctx.entityTypes
      .map((t) => t.id)
      .filter((id) => isLegalChild(grandparentType, id, ctx) && isLegalChild(id, childTypeId, ctx)),
    ctx.entityTypes,
  )
  if (candidates.length === 0) return false

  const retypeCtx = buildRetypeCtx(byId, ctx)
  const rootNode: RetypeNode = { id: parentRow.id, urn: parentRow.id, name: parentRow.name, type: parentRow.typeId }
  for (const candidate of candidates) {
    const plan = planRetype(rootNode, candidate, retypeCtx)
    if (!plan.ok) continue
    for (const change of plan.changes) {
      const changed = byId.get(change.nodeId)
      if (!changed) continue
      changed.typeId = change.toType
      changed.fixes.push({
        field: 'promote',
        note: `Auto-promoted from ${displayName(change.fromType, ctx.entityTypes)} to ${displayName(change.toType, ctx.entityTypes)} so it can hold its new child.`,
      })
    }
    return true
  }
  return false
}

/**
 * Retypes `row` ITSELF (never its parent) to the lowest-level legal type under `parentType`, if one exists.
 * Used specifically when `row`'s current type is a genuine ROOT type illegally nested under `parentType` —
 * promoting the parent could never fix this (a root type, by definition, can never be legally contained by
 * ANY type), so retyping the misplaced child is the only sensible remedy.
 */
function tryRetypeChild(row: BuildRow, parentType: string, ctx: BuildOntologyCtx): boolean {
  const candidates = sortByLevelThenName(
    ctx.entityTypes.map((t) => t.id).filter((id) => isLegalChild(parentType, id, ctx)),
    ctx.entityTypes,
  )
  if (candidates.length === 0) return false
  const fromType = row.typeId!
  row.typeId = candidates[0]
  row.fixes.push({
    field: 'type',
    note: `Retyped from ${displayName(fromType, ctx.entityTypes)} to ${displayName(candidates[0], ctx.entityTypes)} — ${displayName(fromType, ctx.entityTypes)} can never legally nest under ${displayName(parentType, ctx.entityTypes)}.`,
  })
  return true
}

/**
 * Finds the ontology containment chain that would place `row`'s type under an
 * allowed ancestor, synthesizes the missing intermediate BuildRow(s), and
 * relinks `row` under the deepest one. A chain level already synthesized
 * under the same REAL anchor for an earlier row (tracked in `insertedKeys`,
 * keyed by `anchorId::type`) is reused instead of duplicated — sibling rows
 * that share an existing parent and need the same missing ancestors end up
 * sharing one chain. Root-anchored insertions (no real existing parent —
 * `row` is itself top-level) are keyed per-originating-row instead, so
 * distinct top-level rows never merge into one synthesized hierarchy even
 * when they need an identical chain. Returns the ids of the newly-CREATED
 * rows only (root-to-nearest order; empty if the whole chain was reused), or
 * `null` if no chain bridges the gap.
 */
function tryInsertMissingParent(
  row: BuildRow,
  parentRow: BuildRow | null,
  byId: Map<string, BuildRow>,
  ctx: BuildOntologyCtx,
  nextId: () => string,
  insertedKeys: Map<string, string>,
): string[] | null {
  const childType = row.typeId!
  const chains = containmentChains(ctx.entityTypes, ctx.rootEntityTypes)

  let best: { missing: string[]; anchorId: string | null } | undefined
  for (const chain of chains) {
    const i = chain.findIndex((t) => sameId(t, childType))
    if (i < 0) continue
    const prefix = chain.slice(0, i)

    if (!parentRow) {
      // Root row: the whole prefix is missing, chained from a true ontology root.
      if (!best || prefix.length < best.missing.length) best = { missing: prefix, anchorId: null }
      continue
    }
    if (parentRow.typeId == null) continue
    const j = prefix.findIndex((t) => sameId(t, parentRow.typeId!))
    if (j === -1) continue // the existing parent isn't on this chain's path at all
    const missing = prefix.slice(j + 1)
    if (missing.length === 0) continue // parent should already contain it directly — not a chain-insertion fix
    if (!best || missing.length < best.missing.length) best = { missing, anchorId: parentRow.id }
  }
  if (!best) return null

  const newIds: string[] = []
  let anchorId = best.anchorId
  for (const t of best.missing) {
    // Root-anchored (anchorId null, i.e. `row` is itself top-level): scope
    // the key to THIS row so distinct top-level rows never share a
    // synthesized chain, even when the missing chain is identical (see
    // docstring above). Real-anchor keys are unaffected — those legitimately
    // dedup across siblings of the same existing parent.
    const key = anchorId != null ? `${anchorId}::${t.toLowerCase()}` : `root:${row.id}::${t.toLowerCase()}`
    const reused = insertedKeys.get(key)
    if (reused) {
      anchorId = reused
      continue
    }
    const id = nextId()
    const newRow = makeRow({ id, name: displayName(t, ctx.entityTypes), typeId: t, parentId: anchorId })
    newRow.fixes.push({ field: 'parent', note: `Auto-inserted missing ${displayName(t, ctx.entityTypes)} level.` })
    byId.set(id, newRow)
    insertedKeys.set(key, id)
    newIds.push(id)
    anchorId = id
  }
  row.parentId = anchorId
  row.fixes.push({
    field: 'parent',
    note: `Placed under an auto-inserted ${displayName(best.missing[best.missing.length - 1], ctx.entityTypes)}.`,
  })
  return newIds
}

/**
 * Re-orders `rows` (whose parentId edges are already final) into OUTLINE
 * order: a DFS over the parent/child tree where each node is immediately
 * followed by its own full subtree, recursively — the contiguous "row then
 * its whole subtree" invariant buildRow.ts's lastSubtreeIndex maintains,
 * which the outline/grid adapters assume when they indent by row.depth.
 *
 * Roots, and each node's children, are ordered by the position their
 * EARLIEST original-input descendant held in `originalIds`. Synthesized
 * ancestors (from tryInsertMissingParent) have no original position of their
 * own, so they inherit the position of the real row that caused them to be
 * created and — since a node is emitted before its children are visited —
 * land immediately before the rest of their subtree.
 */
function toOutlineOrder(rows: BuildRow[], originalIds: string[]): BuildRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const childrenOfParent = new Map<string | null, BuildRow[]>()
  for (const r of rows) {
    const key = r.parentId != null && byId.has(r.parentId) ? r.parentId : null
    const list = childrenOfParent.get(key)
    if (list) list.push(r)
    else childrenOfParent.set(key, [r])
  }
  const originalIndex = new Map(originalIds.map((id, i) => [id, i]))

  const anchorCache = new Map<string, number>()
  const visiting = new Set<string>()
  function anchorIndex(id: string): number {
    if (anchorCache.has(id)) return anchorCache.get(id)!
    if (visiting.has(id)) return Infinity // cycle guard
    visiting.add(id)
    let best = originalIndex.get(id) ?? Infinity
    for (const child of childrenOfParent.get(id) ?? []) {
      best = Math.min(best, anchorIndex(child.id))
    }
    visiting.delete(id)
    anchorCache.set(id, best)
    return best
  }
  const byAnchor = (a: BuildRow, b: BuildRow) => anchorIndex(a.id) - anchorIndex(b.id)

  const result: BuildRow[] = []
  const visited = new Set<string>()
  function visit(row: BuildRow): void {
    if (visited.has(row.id)) return
    visited.add(row.id)
    result.push(row)
    for (const child of [...(childrenOfParent.get(row.id) ?? [])].sort(byAnchor)) visit(child)
  }
  for (const root of [...(childrenOfParent.get(null) ?? [])].sort(byAnchor)) visit(root)

  // Defensive: never silently drop a row (e.g. a dangling parentId ref not
  // caught above) — fail open by appending anything unvisited.
  for (const r of rows) if (!visited.has(r.id)) result.push(r)
  return result
}

/**
 * Pure: returns a NEW rows array — types inferred, missing parents inserted,
 * leaf parents auto-promoted, each row's status/issues/fixes set. Fails open
 * on unknown/malformed ontology data — never throws.
 */
export function validateBuildRows(rows: BuildRow[], ctx: BuildOntologyCtx): BuildRow[] {
  try {
    return validateBuildRowsUnsafe(rows, ctx)
  } catch {
    return rows
  }
}

function validateBuildRowsUnsafe(rows: BuildRow[], ctx: BuildOntologyCtx): BuildRow[] {
  // Independent working copies (fresh issues/fixes arrays) so the input is never mutated.
  const cloned = rows.map((r) => ({ ...r, issues: [...r.issues], fixes: [...r.fixes] }))
  const withDepths = reindexDepths(cloned)
  const byId = new Map(withDepths.map((r) => [r.id, r]))
  // Original topological (parent-before-child) order; insertions only add NEW
  // ancestors above a row, so this order stays valid throughout processing.
  const order = [...withDepths].sort((a, b) => a.depth - b.depth).map((r) => r.id)

  let autoCounter = 0
  const nextId = (): string => {
    let id = `auto-${autoCounter++}`
    while (byId.has(id)) id = `auto-${autoCounter++}`
    return id
  }

  // Pass 1: type finalization. Infer missing types top-down (a row's type can
  // depend on its parent's), THEN let a child's now-final type promote an
  // incompatible parent, bottom-up (a parent's need to contain a child can
  // only be known once the child's type is settled). Placement (Pass 2) only
  // runs once every row's type is final, so a row promoted into a valid root
  // type never also gets a redundant synthetic parent inserted.
  for (const id of order) {
    const row = byId.get(id)!
    if (row.typeId != null) continue
    const parentRow = row.parentId != null ? (byId.get(row.parentId) ?? null) : null
    const parentType = parentRow?.typeId ?? null
    const candidates = ctx.entityTypes.map((t) => t.id).filter((c) => isLegalChild(parentType, c, ctx))
    if (candidates.length === 1) {
      row.typeId = candidates[0]
      row.fixes.push({ field: 'type', note: `Inferred type '${displayName(candidates[0], ctx.entityTypes)}'.` })
    } else if (candidates.length > 1) {
      const chosen = sortByLevelThenName(candidates, ctx.entityTypes)[0]
      row.typeId = chosen
      row.fixes.push({
        field: 'type',
        note: `Inferred type '${displayName(chosen, ctx.entityTypes)}' (${candidates.length} types were allowed here).`,
      })
    } else {
      row.issues.push({ message: `Couldn't determine a type for '${row.name || row.id}'.` })
    }
  }

  for (const id of [...order].reverse()) {
    const row = byId.get(id)!
    if (row.typeId == null) continue
    const parentRow = row.parentId != null ? (byId.get(row.parentId) ?? null) : null
    if (parentRow && parentRow.typeId != null && !isLegalChild(parentRow.typeId, row.typeId, ctx)) {
      // A genuine root type can never be legally contained by ANY parent, so promoting the parent could
      // never fix this — retyping the misplaced child is the only sensible remedy, and takes priority.
      // Otherwise (parent's own type is simply wrong for this child), keep the existing remedy: promote
      // the parent to something that can hold it.
      const retyped = isRootOnlyType(row.typeId, ctx) && tryRetypeChild(row, parentRow.typeId, ctx)
      if (!retyped) tryAutoPromoteParent(parentRow, row.typeId, byId, ctx)
    }
  }

  // Pass 2: placement. With every row's type now final, insert missing
  // ancestors for any row still in an invalid position; sibling rows that
  // share a REAL existing parent and need the same missing chain share one
  // synthesized chain (see insertedKeys in tryInsertMissingParent) instead of
  // each synthesizing their own — distinct top-level rows never share.
  const insertedKeys = new Map<string, string>()
  const output: BuildRow[] = []
  for (const id of order) {
    const row = byId.get(id)!
    const parentRow = row.parentId != null ? (byId.get(row.parentId) ?? null) : null

    if (row.typeId != null) {
      const containmentOk = !parentRow
        ? isLegalChild(null, row.typeId, ctx)
        : parentRow.typeId == null
          ? true // parent's own type is unresolved/errored — don't cascade a second error onto this row
          : isLegalChild(parentRow.typeId, row.typeId, ctx)

      if (!containmentOk) {
        const newIds = tryInsertMissingParent(row, parentRow, byId, ctx, nextId, insertedKeys)
        if (newIds) {
          for (const newId of newIds) output.push(byId.get(newId)!)
        } else {
          const childName = displayName(row.typeId, ctx.entityTypes)
          const message = parentRow
            ? `${capitalize(article(childName))} ${childName} can't sit directly under ${article(displayName(parentRow.typeId, ctx.entityTypes))} ${displayName(parentRow.typeId, ctx.entityTypes)}.`
            : `${capitalize(article(childName))} ${childName} can't be placed at the top level.`
          row.issues.push({ message })
        }
      }
    }

    output.push(row)
  }

  // Pass 3: status. Plain-language issues were set during placement above.
  const finalized = output.map((r) => ({
    ...r,
    status: (r.issues.length > 0 ? 'error' : r.fixes.length > 0 ? 'fixed' : 'valid') as BuildRow['status'],
  }))
  // `output`/`finalized` are still in Pass 2's internal depth-first-by-LEVEL
  // processing order (needed so every row's real parent is resolved before
  // it's placed) — NOT outline order. Re-derive outline order (each row
  // immediately followed by its own subtree) from the now-final parentId
  // tree before returning; see toOutlineOrder for why.
  return reindexDepths(toOutlineOrder(finalized, rows.map((r) => r.id)))
}
