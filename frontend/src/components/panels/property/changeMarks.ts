/**
 * What each property says about its edit: new since the entity was read, changed from what was
 * read (and what it was), or removed. Compared key by key against the properties as first read —
 * the same base the save's patch is judged against — so a value put back reads as unchanged.
 */

export type ChangeMark = 'new' | 'changed'

export interface PropertyMarks {
  /** Keys whose value differs from the one read, or that were not there. */
  marks: Map<string, { mark: ChangeMark; was?: unknown }>
  /** Keys that were read and are gone, with the value they had. */
  removed: [string, unknown][]
}

const EMPTY: PropertyMarks = { marks: new Map(), removed: [] }

const same = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

export function propertyMarks(value: Record<string, unknown>, original: Record<string, unknown> | undefined): PropertyMarks {
  if (!original) return EMPTY
  const marks: PropertyMarks['marks'] = new Map()
  for (const [k, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(original, k)) marks.set(k, { mark: 'new' })
    else if (!same(v, original[k])) marks.set(k, { mark: 'changed', was: original[k] })
  }
  const removed = Object.entries(original).filter(([k]) => !Object.prototype.hasOwnProperty.call(value, k))
  return marks.size === 0 && removed.length === 0 ? EMPTY : { marks, removed }
}

/** A value as one short line, for "Was: …". */
export function shortValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.join(', ') : 'none'
  if (typeof v === 'object') {
    try { const s = JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 77)}…` : s } catch { return String(v) }
  }
  const s = String(v)
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}
