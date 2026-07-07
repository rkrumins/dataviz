/**
 * Pure grandparent lookup backing BuildOutline's Shift+Tab (outdent). Split
 * out of BuildOutline.tsx so the component file only exports components
 * (react-refresh/only-export-components) and so this is unit-testable
 * without React.
 */
import type { BuildRow } from './buildRow'

/**
 * `undefined` = no-op (row is already a root, or unknown) — the caller
 * should skip the `updateRow` call in that case. Mirrors the guard in
 * `buildRow.ts`'s own (rail-only) `outdent`.
 */
export function grandparentIdOf(rows: BuildRow[], id: string): string | null | undefined {
  const row = rows.find((r) => r.id === id)
  if (!row || row.parentId == null) return undefined
  const parent = rows.find((r) => r.id === row.parentId)
  return parent ? parent.parentId : null
}
