/**
 * applyBuild — the one thing Apply adds on top of `validateBuildRows`: a row
 * left with `status: 'error'` has no valid parent chain, so staging it (or
 * anything nested under it) would attach a child to a parent that was never
 * created. `filterStageableRows` drops every errored row AND its whole
 * subtree, in one pass — pure, no store/React imports, so it unit-tests
 * without mocks (mirrors the growing-Set pattern in `buildRow.ts`'s own
 * `removeRow`).
 */
import type { BuildRow } from './buildRow'

/** Rows Apply should actually stage: `status: 'error'` rows and all their descendants removed. */
export function filterStageableRows(rows: BuildRow[]): BuildRow[] {
  const skip = new Set(rows.filter((r) => r.status === 'error').map((r) => r.id))
  let changed = true
  while (changed) {
    changed = false
    for (const r of rows) {
      if (r.parentId != null && skip.has(r.parentId) && !skip.has(r.id)) {
        skip.add(r.id)
        changed = true
      }
    }
  }
  return rows.filter((r) => !skip.has(r.id))
}
