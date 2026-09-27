/**
 * Created / last changed for a relationship — derived from its version history,
 * because an edge carries no timestamps of its own.
 *
 * Only the main line and the open draft count: a manager's history response
 * also holds OTHER people's drafts, which say nothing about this reader's
 * relationship. `commit_seq` restarts on every branch, so rows are ordered
 * within their branch, never across. A main row names whoever committed it —
 * for a published draft that is the publisher, not the author.
 */
import { actorName } from '@/features/versioning/model/branchVocab'

export interface HistoryVersion {
  commit_seq?: number
  branch_id?: string
  op?: string
  actor?: string | null
  created_at?: string
}

export interface ProvenanceMark {
  at?: string
  by: string
  /** The row is on the open draft — not published yet. */
  inDraft: boolean
}

const bySeq = (a: HistoryVersion, b: HistoryVersion) =>
  (a.commit_seq ?? 0) - (b.commit_seq ?? 0) || (a.created_at ?? '').localeCompare(b.created_at ?? '')

export function summarizeProvenance(
  versions: HistoryVersion[],
  opts: { mainBranchId?: string | null; branchId?: string | null; userNames?: Record<string, string> },
): { created?: ProvenanceMark; updated?: ProvenanceMark } {
  const onDraft = !!opts.branchId && opts.branchId !== opts.mainBranchId
  const draft = onDraft ? versions.filter((v) => v.branch_id === opts.branchId).sort(bySeq) : []
  const main = (opts.mainBranchId
    ? versions.filter((v) => v.branch_id === opts.mainBranchId)
    : versions.filter((v) => !onDraft || v.branch_id !== opts.branchId)
  ).sort(bySeq)

  const mark = (v: HistoryVersion | undefined, inDraft: boolean): ProvenanceMark | undefined =>
    v ? { at: v.created_at, by: actorName(v.actor, opts.userNames), inDraft } : undefined
  const lastCreate = (rows: HistoryVersion[]) => [...rows].reverse().find((v) => v.op === 'create')

  // Created in this draft wins: it is the relationship as it now exists here.
  const draftCreate = lastCreate(draft)
  return {
    created: draftCreate ? mark(draftCreate, true) : mark(lastCreate(main), false),
    updated: draft.length > 0 ? mark(draft[draft.length - 1], true) : mark(main[main.length - 1], false),
  }
}
