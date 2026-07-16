/**
 * ontology-diff — pure diff over ontology definition maps (server vs working
 * copy). Shared by ChangesReviewDialog (pre-save summary) and ChangesTray
 * (persistent per-change chips with revert).
 */
import { humanizeId } from './ontology-parsers'

export interface DiffItem {
  id: string
  label: string
  /** For modified items, the list of top-level fields that changed. */
  changedFields?: string[]
}

export interface DiffResult {
  added: DiffItem[]
  modified: DiffItem[]
  removed: DiffItem[]
}

/**
 * Compute a simple diff between two Record<string, unknown> maps.
 * - Added:    IDs present in `working` but absent in `server`.
 * - Removed:  IDs present in `server` but absent in `working`.
 * - Modified: IDs present in both but with different JSON representations.
 */
export function diffRecords(
  server: Record<string, unknown>,
  working: Record<string, unknown>,
): DiffResult {
  const serverIds = new Set(Object.keys(server))
  const workingIds = new Set(Object.keys(working))

  const added: DiffItem[] = []
  const removed: DiffItem[] = []
  const modified: DiffItem[] = []

  for (const id of workingIds) {
    if (!serverIds.has(id)) {
      added.push({ id, label: humanizeId(id) })
    }
  }

  for (const id of serverIds) {
    if (!workingIds.has(id)) {
      removed.push({ id, label: humanizeId(id) })
    }
  }

  for (const id of workingIds) {
    if (!serverIds.has(id)) continue
    const serverJson = JSON.stringify(server[id])
    const workingJson = JSON.stringify(working[id])
    if (serverJson !== workingJson) {
      const serverObj = (server[id] ?? {}) as Record<string, unknown>
      const workingObj = (working[id] ?? {}) as Record<string, unknown>
      const allKeys = new Set([...Object.keys(serverObj), ...Object.keys(workingObj)])
      const changedFields: string[] = []
      for (const key of allKeys) {
        if (JSON.stringify(serverObj[key]) !== JSON.stringify(workingObj[key])) {
          changedFields.push(key)
        }
      }
      modified.push({ id, label: humanizeId(id), changedFields })
    }
  }

  return { added, modified, removed }
}
