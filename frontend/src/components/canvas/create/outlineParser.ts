/**
 * outlineParser — parses a pasted indented outline (bulk-paste mode for the
 * Hierarchy Builder) into rows resolved against the ontology. Pure, no React
 * / store dependency — the ontology is passed in via `OutlineParseContext`;
 * type/edge legality is delegated to `ontologyPreflightService`, never
 * duplicated here.
 */
import { allowedChildTypeIds, deriveContainmentEdges } from '@/services/ontologyPreflightService'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

export interface ParsedOutlineRow {
  name: string
  typeId: string | null // resolved entity type id, or null when nothing is allowed
  explicitType: boolean // true when the row named its type via "Type: Name" prefix
  depth: number // 0-based, relative to the paste root
  issues: string[] // plain-language problems; empty = stageable
}

export interface OutlineParseContext {
  entityTypes: EntityTypeSchema[]
  rootEntityTypes: string[]
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  /** Type of the node the builder is scoped to; null = pasting at root level. */
  rootParentType: string | null
}

const typeName = (id: string, entityTypes: EntityTypeSchema[]): string =>
  entityTypes.find((et) => et.id === id)?.name ?? id

/** Lowest hierarchy.level first, then name. */
function pickByLevelThenName(ids: string[], entityTypes: EntityTypeSchema[]): string {
  const byId = new Map(entityTypes.map((et) => [et.id, et]))
  return [...ids].sort((a, b) => {
    const ea = byId.get(a)
    const eb = byId.get(b)
    const levelDiff = (ea?.hierarchy.level ?? 0) - (eb?.hierarchy.level ?? 0)
    return levelDiff !== 0 ? levelDiff : (ea?.name ?? a).localeCompare(eb?.name ?? b)
  })[0]
}

/** Leading tabs (1 level each) and leading spaces (in the text's inferred unit). */
function leadingWhitespace(line: string): { tabs: number; spaces: number } {
  const m = /^(\t*)( *)/.exec(line)!
  return { tabs: m[1].length, spaces: m[2].length }
}

/** Smallest positive delta between distinct leading-space counts seen (fallback 2). */
function inferSpaceUnit(lines: string[]): number {
  const counts = new Set<number>([0])
  for (const line of lines) counts.add(leadingWhitespace(line).spaces)
  const sorted = [...counts].sort((a, b) => a - b)
  let unit = Infinity
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i] - sorted[i - 1]
    if (delta > 0 && delta < unit) unit = delta
  }
  return unit === Infinity ? 2 : unit
}

/** Strip a single leading "- " or "* " bullet. */
function stripBullet(content: string): string {
  return /^[-*] /.test(content) ? content.slice(2) : content
}

/** Match a "Type: rest" prefix against entity type id/name (case-insensitive). */
function matchExplicitType(
  content: string,
  entityTypes: EntityTypeSchema[],
): { typeId: string; name: string } | null {
  const idx = content.indexOf(':')
  if (idx < 0) return null
  const candidate = content.slice(0, idx).trim().toLowerCase()
  const match = entityTypes.find(
    (et) => et.id.toLowerCase() === candidate || et.name.toLowerCase() === candidate,
  )
  if (!match) return null
  return { typeId: match.id, name: content.slice(idx + 1).trim() }
}

function resolveRow(args: {
  name: string
  explicitTypeId: string | null
  depth: number
  parentRow: ParsedOutlineRow | undefined
  ctx: OutlineParseContext
}): ParsedOutlineRow {
  const { name, explicitTypeId, depth, parentRow, ctx } = args
  const explicitType = explicitTypeId !== null

  if (depth > 0 && parentRow?.typeId === null) {
    return { name, typeId: null, explicitType, depth, issues: ['Fix the row above first.'] }
  }

  const parentType = depth === 0 ? ctx.rootParentType : (parentRow!.typeId as string)
  const allowed = allowedChildTypeIds(parentType, ctx.entityTypes, ctx.rootEntityTypes, ctx.hierarchyMap)
  const issues: string[] = []

  let typeId: string | null = null
  if (explicitTypeId && allowed.has(explicitTypeId)) {
    typeId = explicitTypeId
  } else if (allowed.size === 1) {
    typeId = [...allowed][0]
  } else if (allowed.size > 1) {
    typeId = pickByLevelThenName([...allowed], ctx.entityTypes)
  }

  if (explicitTypeId && !allowed.has(explicitTypeId)) {
    const parentLabel = parentType ? typeName(parentType, ctx.entityTypes) : null
    const explicitLabel = typeName(explicitTypeId, ctx.entityTypes)
    issues.push(
      parentLabel ? `A ${parentLabel} can't contain a ${explicitLabel}.` : `A ${explicitLabel} can't be added here.`,
    )
  }
  if (allowed.size === 0) {
    issues.push(
      parentType
        ? `Nothing can be added inside a ${typeName(parentType, ctx.entityTypes)}.`
        : 'Nothing can be added here.',
    )
  }
  if (typeId && depth > 0) {
    const edges = deriveContainmentEdges(parentType, typeId, ctx.relationshipTypes, ctx.containmentEdgeTypes)
    if (!edges.some((e) => e.allowed)) {
      issues.push(
        `A ${typeName(parentType as string, ctx.entityTypes)} can't contain a ${typeName(typeId, ctx.entityTypes)}.`,
      )
    }
  }

  return { name, typeId, explicitType, depth, issues }
}

export function parseIndentedOutline(text: string, ctx: OutlineParseContext): ParsedOutlineRow[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const spaceUnit = inferSpaceUnit(lines)

  const rows: ParsedOutlineRow[] = []
  const ancestorAtDepth: (ParsedOutlineRow | undefined)[] = []
  let prevDepth = -1

  for (const line of lines) {
    const { tabs, spaces } = leadingWhitespace(line)
    const rawDepth = tabs + Math.round(spaces / spaceUnit)
    const depth = Math.max(0, Math.min(rawDepth, prevDepth + 1))
    prevDepth = depth

    const content = stripBullet(line.trim())
    const explicit = matchExplicitType(content, ctx.entityTypes)
    const name = explicit ? explicit.name : content

    const parentRow = depth > 0 ? ancestorAtDepth[depth - 1] : undefined
    const row = resolveRow({ name, explicitTypeId: explicit?.typeId ?? null, depth, parentRow, ctx })

    rows.push(row)
    ancestorAtDepth[depth] = row
  }

  return rows
}
