/**
 * useDraftDataKey — what a draft's counts, rule chips and property catalog depend on besides the
 * view: which branch is open, its epoch (an import, others' saves taken in), what it has saved, and
 * how far its bulk property jobs have written. The server answers those reads for the draft as it
 * stands, so a hook that keys its answers by this asks again as the draft changes — window by
 * window while a bulk change runs — and a draft's answers are never shown for Published's.
 */
import { useBranchStore } from '@/store/branchStore'
import { useDraftPropertyJobs } from '@/store/propertyJobsStore'

export function useDraftDataKey(): string {
  const graphId = useBranchStore((s) => s.graphId)
  const branchId = useBranchStore((s) => s.currentBranchId)
  const epoch = useBranchStore((s) => s.draftEpoch)
  // The draft's saved changes, by count: a save that adds to them is a new draft to count.
  const changes = useBranchStore((s) => {
    const c = s.isDraftMode() ? s.activeChangeSet?.counts : null
    return c ? `${c.added}.${c.removed}.${c.modified}` : ''
  })
  const jobs = useDraftPropertyJobs(graphId, branchId)
  const written = jobs
    .map((j) => `${j.jobId}:${j.job?.status ?? ''}:${j.job?.summary?.commits ?? j.job?.processed ?? 0}`)
    .join(',')
  return `${branchId ?? ''}|${epoch}|${changes}|${written}`
}
