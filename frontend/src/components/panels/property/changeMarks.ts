/**
 * What each property says about how it changed: new, changed (and what it was), or removed — and
 * whether that change is saved in the draft yet or still only staged.
 *
 * Told against what is published (`published`: main where the draft began) when it is known, so a
 * change saved in the draft keeps saying so; else against the properties as first read (`original`)
 * — the same base the save's patch is judged against. A change differs from `original` when it is
 * not saved yet (`unsaved`). A value put back reads as unchanged.
 */

export type ChangeMark = 'new' | 'changed'

export interface MarkInfo {
  mark: ChangeMark
  /** What it was (published, or as read), for a changed one. */
  was?: unknown
  /** Staged, not saved in the draft yet. */
  unsaved: boolean
}

export interface PropertyMarks {
  /** Keys whose value differs from the base, or that were not there. */
  marks: Map<string, MarkInfo>
  /** Keys the base had that are gone, with the value they had. */
  removed: [string, unknown][]
  /** Of `removed`, those an edit not saved yet removed. */
  unsavedRemoved: ReadonlySet<string>
}

const EMPTY: PropertyMarks = { marks: new Map(), removed: [], unsavedRemoved: new Set() }

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

const same = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

export function propertyMarks(
  value: Record<string, unknown>,
  original: Record<string, unknown> | undefined,
  published?: Record<string, unknown>,
): PropertyMarks {
  const base = published ?? original
  if (!base) return EMPTY
  // Not saved yet: it differs from the properties as read. Without a published base, every mark is.
  const unsavedKey = (k: string) => (published === undefined ? true
    : original === undefined ? false
      : has(value, k) ? !(has(original, k) && same(value[k], original[k])) : has(original, k))
  const marks: PropertyMarks['marks'] = new Map()
  for (const [k, v] of Object.entries(value)) {
    if (!has(base, k)) marks.set(k, { mark: 'new', unsaved: unsavedKey(k) })
    else if (!same(v, base[k])) marks.set(k, { mark: 'changed', was: base[k], unsaved: unsavedKey(k) })
  }
  const removed = Object.entries(base).filter(([k]) => !has(value, k))
  if (marks.size === 0 && removed.length === 0) return EMPTY
  return { marks, removed, unsavedRemoved: new Set(removed.filter(([k]) => unsavedKey(k)).map(([k]) => k)) }
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
