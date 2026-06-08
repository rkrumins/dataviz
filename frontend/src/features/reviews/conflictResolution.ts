/**
 * Pure logic for turning a reviewer's field-level conflict picks into the merge API's
 * resolution map. The backend reports conflicts as `{entity_id, path, base, ours, theirs}`
 * (a field slice) but accepts resolutions as whole-entity payloads (`{entityId: payload |
 * null}`). So per entity we seed from the merged payload (the diff's `after`, which already
 * has every non-conflicting field) and overlay each picked value at its path. Extracted
 * from ConflictResolver so it is unit-testable without rendering.
 */
import type { ResolutionMap } from '@/services/versioningApiService'

export type Side = 'theirs' | 'ours' | 'base'

export interface Conflict {
  entity_id: string
  path: (string | number)[]
  base?: unknown
  ours?: unknown
  theirs?: unknown
  kind?: string
}

/** Normalise a raw backend conflict (snake_case, occasionally camelCase) into our shape. */
export function normalizeConflict(raw: Record<string, unknown>): Conflict {
  return {
    entity_id: String(raw.entity_id ?? raw.entityId ?? ''),
    path: (raw.path as (string | number)[]) ?? [],
    base: raw.base,
    ours: raw.ours,
    theirs: raw.theirs,
    kind: raw.kind as string | undefined,
  }
}

/** Stable key for a single conflicting field (entity + path). */
export const conflictKey = (c: Conflict) => `${c.entity_id}::${c.path.join('.')}`

/** Immutable deep-set of `value` at `path` within `obj`. Empty path replaces the whole entity. */
export function setIn(obj: Record<string, unknown>, path: (string | number)[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return (value ?? {}) as Record<string, unknown>
  const [head, ...rest] = path
  const clone: Record<string, unknown> | unknown[] = Array.isArray(obj) ? [...obj] : { ...obj }
  ;(clone as Record<string | number, unknown>)[head] =
    rest.length === 0 ? value : setIn(((clone as Record<string | number, unknown>)[head] as Record<string, unknown>) ?? {}, rest, value)
  return clone as Record<string, unknown>
}

/** Group conflicts by entity (preserving order). */
export function groupByEntity(conflicts: Conflict[]): Map<string, Conflict[]> {
  const m = new Map<string, Conflict[]>()
  for (const c of conflicts) {
    const arr = m.get(c.entity_id)
    if (arr) arr.push(c)
    else m.set(c.entity_id, [c])
  }
  return m
}

/**
 * Assemble the resolution map: per entity, either `null` (delete) or its seed payload with
 * each conflicting field overlaid by the chosen side's value.
 */
export function buildResolutions(
  byEntity: Map<string, Conflict[]>,
  picks: Record<string, Side>,
  deleted: Record<string, boolean>,
  seeds: Record<string, Record<string, unknown> | undefined>,
): ResolutionMap {
  const res: ResolutionMap = {}
  for (const [eid, list] of byEntity) {
    if (deleted[eid]) {
      res[eid] = null
      continue
    }
    let payload: Record<string, unknown> = { ...(seeds[eid] ?? {}) }
    for (const c of list) {
      const side = picks[conflictKey(c)] ?? 'ours'
      payload = setIn(payload, c.path, c[side])
    }
    res[eid] = payload
  }
  return res
}
