/**
 * One pending change per property, over a `BulkEdit`.
 *
 * The comparison edits a property at a time — set for all, fill where missing, rename, copy,
 * remove — and a property has at most one of these pending: choosing another replaces it, and
 * reverting it leaves the property as each entity holds it.
 */
import type { BulkEdit } from '@/components/canvas/context-view/bulkEdit'

export type KeyChange =
  | { kind: 'set'; value: unknown }
  | { kind: 'fill'; value: unknown }
  | { kind: 'unset' }
  | { kind: 'move'; to: string; keep: boolean; overwrite: boolean }

export const EMPTY_EDIT: BulkEdit = { set: {}, fill: {}, moves: [], unset: [] }

/** The change pending on `key`, if any. */
export function changeOf(edit: BulkEdit, key: string): KeyChange | null {
  if (key in edit.set) return { kind: 'set', value: edit.set[key] }
  if (edit.fill && key in edit.fill) return { kind: 'fill', value: edit.fill[key] }
  if (edit.unset.includes(key)) return { kind: 'unset' }
  const m = edit.moves?.find((mv) => mv.from === key)
  return m ? { kind: 'move', to: m.to, keep: !!m.keep, overwrite: !!m.overwrite } : null
}

/** `edit` with `change` pending on `key` in place of whatever was — or nothing, for `null`. */
export function withChange(edit: BulkEdit, key: string, change: KeyChange | null): BulkEdit {
  const set = { ...edit.set }
  const fill = { ...edit.fill }
  delete set[key]
  delete fill[key]
  const unset = edit.unset.filter((k) => k !== key)
  const moves = (edit.moves ?? []).filter((m) => m.from !== key)
  if (change?.kind === 'set') set[key] = change.value
  else if (change?.kind === 'fill') fill[key] = change.value
  else if (change?.kind === 'unset') unset.push(key)
  else if (change?.kind === 'move') moves.push({ from: key, to: change.to, keep: change.keep, overwrite: change.overwrite })
  return { ...edit, set, fill, unset, moves }
}

/** Names a new property could not take: one already held, or one a pending rename or copy takes. */
export function takenNames(keys: readonly string[], edit: BulkEdit, except?: string): Set<string> {
  const taken = new Set(keys)
  for (const k of Object.keys(edit.set)) taken.add(k)
  for (const m of edit.moves ?? []) if (m.from !== except) taken.add(m.to)
  return taken
}
