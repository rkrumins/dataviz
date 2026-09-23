/**
 * The importer's answers to what didn't match, as pure functions over `Resolutions` (the shape
 * the server applies): keep an entity (the default, marked not found), drop it, or point it at
 * another entity; map a missing type to one that exists here, or drop it.
 */
import type { ReconcileReport, Resolutions } from '@/services/viewTransferApiService'

export type EntityDecision = { kind: 'keep' } | { kind: 'drop' } | { kind: 'remap'; urn: string }

export function decisionOf(r: Resolutions, urn: string): EntityDecision {
  if (r.drop?.includes(urn)) return { kind: 'drop' }
  const to = r.remap?.[urn]
  return to !== undefined ? { kind: 'remap', urn: to } : { kind: 'keep' }
}

export function withDecision(r: Resolutions, urn: string, decision: EntityDecision): Resolutions {
  const drop = (r.drop ?? []).filter(u => u !== urn)
  const remap = { ...(r.remap ?? {}) }
  delete remap[urn]
  if (decision.kind === 'drop') drop.push(urn)
  if (decision.kind === 'remap') remap[urn] = decision.urn
  return { ...r, drop, remap }
}

export function withDecisions(r: Resolutions, urns: string[], decision: EntityDecision): Resolutions {
  return urns.reduce((acc, urn) => withDecision(acc, urn, decision), r)
}

export type TypeKind = 'entity' | 'relationship'

/** `target`: a type id here to map to, `null` to drop the type, `undefined` to leave it. */
export function typeDecisionOf(r: Resolutions, kind: TypeKind, id: string): string | null | undefined {
  const map = kind === 'entity' ? r.typeMap : r.relTypeMap
  const drops = kind === 'entity' ? r.dropTypes : r.dropRelTypes
  if (drops?.includes(id)) return null
  return map?.[id]
}

export function withTypeDecision(r: Resolutions, kind: TypeKind, id: string, target: string | null | undefined): Resolutions {
  const mapKey = kind === 'entity' ? 'typeMap' : 'relTypeMap'
  const dropKey = kind === 'entity' ? 'dropTypes' : 'dropRelTypes'
  const map = { ...(r[mapKey] ?? {}) }
  const drops = (r[dropKey] ?? []).filter(t => t !== id)
  delete map[id]
  if (target === null) drops.push(id)
  else if (target !== undefined) map[id] = target
  return { ...r, [mapKey]: map, [dropKey]: drops }
}

/** How many decisions differ from "keep everything as it is". */
export function resolutionCount(r: Resolutions): number {
  return (r.drop?.length ?? 0) + Object.keys(r.remap ?? {}).length
    + Object.keys(r.typeMap ?? {}).length + (r.dropTypes?.length ?? 0)
    + Object.keys(r.relTypeMap ?? {}).length + (r.dropRelTypes?.length ?? 0)
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort()
}

function sameMap(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const ak = Object.keys(a ?? {}).sort()
  const bk = Object.keys(b ?? {}).sort()
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a![k] === b![k])
}

export function sameResolutions(a: Resolutions, b: Resolutions): boolean {
  return sorted(a.drop).join('\n') === sorted(b.drop).join('\n')
    && sorted(a.dropTypes).join('\n') === sorted(b.dropTypes).join('\n')
    && sorted(a.dropRelTypes).join('\n') === sorted(b.dropRelTypes).join('\n')
    && sameMap(a.remap, b.remap) && sameMap(a.typeMap, b.typeMap) && sameMap(a.relTypeMap, b.relTypeMap)
}

/**
 * The score these choices will give, before the server re-checks them. The report already
 * reflects `applied` (dropped entities are gone from it, remapped ones appear under their new
 * URN), so only what `draft` adds on top can be projected: a newly dropped entity leaves the
 * count. A remap, or a decision taken back, can't be scored until the server looks again, so
 * those are reported as pending instead.
 */
export function projectedRate(report: ReconcileReport, applied: Resolutions, draft: Resolutions): {
  rate: number | null
  pending: number
} {
  const entities = report.summary.entities
  let checked = entities.checked
  let found = entities.found
  let pending = 0
  for (const row of report.entities) {
    const decision = decisionOf(draft, row.urn)
    if (decision.kind === 'drop' && row.status !== 'unknown') {
      checked -= 1
      if (row.status !== 'missing') found -= 1
    }
    if (decision.kind === 'remap') pending += 1
  }
  pending += (applied.drop ?? []).filter(urn => !draft.drop?.includes(urn)).length
  pending += Object.entries(applied.remap ?? {}).filter(([urn, to]) => draft.remap?.[urn] !== to).length
  return { rate: checked > 0 ? found / checked : null, pending }
}
