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
  containmentChains,
  deriveContainmentEdges,
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

function canContainVia(parentType: string, childType: string, ctx: BuildOntologyCtx): boolean {
  return deriveContainmentEdges(parentType, childType, ctx.relationshipTypes, ctx.containmentEdgeTypes).some(
    (e) => e.allowed,
  )
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
  const fitsGrandparent = allowedChildTypeIds(grandparentType, ctx.entityTypes, ctx.rootEntityTypes, ctx.hierarchyMap)
  const candidates = sortByLevelThenName(
    ctx.entityTypes
      .map((t) => t.id)
      .filter((id) => setHasId(fitsGrandparent, id) && canContainVia(id, childTypeId, ctx)),
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
 * Finds the ontology containment chain that would place `row`'s type under an
 * allowed ancestor, synthesizes the missing intermediate BuildRow(s), and
 * relinks `row` under the deepest one. A chain level already synthesized
 * under the same anchor for an earlier row (tracked in `insertedKeys`, keyed
 * by `anchorId::type`) is reused instead of duplicated — sibling rows needing
 * the same missing ancestors end up sharing one chain. Returns the ids of the
 * newly-CREATED rows only (root-to-nearest order; empty if the whole chain
 * was reused), or `null` if no chain bridges the gap.
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
    const key = `${anchorId ?? '(root)'}::${t.toLowerCase()}`
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
    const candidates = [...allowedChildTypeIds(parentType, ctx.entityTypes, ctx.rootEntityTypes, ctx.hierarchyMap)]
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
    if (parentRow && parentRow.typeId != null && !canContainVia(parentRow.typeId, row.typeId, ctx)) {
      tryAutoPromoteParent(parentRow, row.typeId, byId, ctx)
    }
  }

  // Pass 2: placement. With every row's type now final, insert missing
  // ancestors for any row still in an invalid position; sibling rows needing
  // the same missing chain share one synthesized chain (see insertedKeys in
  // tryInsertMissingParent) instead of each synthesizing their own.
  const insertedKeys = new Map<string, string>()
  const output: BuildRow[] = []
  for (const id of order) {
    const row = byId.get(id)!
    const parentRow = row.parentId != null ? (byId.get(row.parentId) ?? null) : null

    if (row.typeId != null) {
      const containmentOk = !parentRow
        ? setHasId(allowedChildTypeIds(null, ctx.entityTypes, ctx.rootEntityTypes, ctx.hierarchyMap), row.typeId)
        : parentRow.typeId == null
          ? true // parent's own type is unresolved/errored — don't cascade a second error onto this row
          : canContainVia(parentRow.typeId, row.typeId, ctx)

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
  return reindexDepths(finalized)
}
