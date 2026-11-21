/**
 * UndoJobButton — what an ended bulk change's row says about undoing it. **Undo** on a change that
 * wrote to the draft and is still only there: a confirm says how many entities it puts back, and
 * that any changed since are left as they are, and listed; the undo is then another change on the
 * draft, followed like the rest. **Undone** once an undo has finished. On an undo's own row, how
 * many it left because they changed since. Nothing for a change that can't be undone: published,
 * in whole or in part, or one that wrote nothing.
 */
import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { generateId } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { JobActiveError, PropertyJobUndoRefusedError, undoPropertyJob } from '@/services/versioningApiService'
import { jobEnded, usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'
import { propertyJobLabel } from './op/opModel'

/** Why an undo couldn't start, and what to do instead. */
export function undoErrorCopy(e: unknown): string {
  if (e instanceof JobActiveError) return 'Another change is running on this draft — wait for it to finish, then undo this one.'
  if (e instanceof PropertyJobUndoRefusedError) {
    switch (e.code) {
      case 'job_published': return 'This change has been published — make a new change instead.'
      case 'already_undone': return 'Already undone.'
      case 'nothing_to_undo': return 'This change didn’t change anything, so there is nothing to undo.'
      case 'undo_of_undo': return 'An undo can’t be undone — make the change again instead.'
    }
  }
  return `The undo couldn’t start — ${(e as Error).message || 'try again'}.`
}

export function UndoJobButton({ tracked }: { tracked: TrackedJob }) {
  const { notify } = useAppNotifications()
  // How the undos of this change this browser follows stand: one has finished, or one is running.
  const undoing = usePropertyJobsStore((st) => {
    const undos = st.jobs.filter((j) => j.op.kind === 'undo' && j.op.sourceJobId === tracked.jobId)
    return undos.some((j) => j.job?.status === 'completed') ? 'done' : undos.some((j) => !jobEnded(j)) ? 'running' : null
  })
  // One key per confirm: a retry of it is the same undo; asking again later, a new one.
  const [key, setKey] = useState<string | null>(null)
  const job = tracked.job
  const s = job?.summary ?? {}
  const relationships = tracked.entityKind === 'edge' || job?.entityKind === 'edge'
  if (!job || !jobEnded(tracked)) return null

  if (tracked.op.kind === 'undo') {
    const since = s.changedSince ?? 0
    return since > 0 ? (
      <p className="mt-0.5 text-[11px] text-ink-secondary">
        <span className="tabular-nums text-amber-700 dark:text-amber-300">{since.toLocaleString()}</span> changed again
        since — left as they are
      </p>
    ) : null
  }
  if (s.undoneBy || undoing === 'done') {
    return (
      <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-secondary">
        <Undo2 className="h-3 w-3" aria-hidden /> Undone
      </p>
    )
  }
  const published = !!s.publishedCommitId || (s.landedCommitIds?.length ?? 0) > 0
  if (published || (s.commits ?? 0) < 1 || undoing === 'running') return null

  const label = propertyJobLabel(tracked.op)
  const n = s.changed ?? 0
  const things = relationships ? (n === 1 ? 'relationship' : 'relationships') : (n === 1 ? 'entity' : 'entities')
  const confirm = async () => {
    try {
      const started = await undoPropertyJob(tracked.wsId, tracked.graphId, tracked.jobId, key ?? generateId('propundo'))
      usePropertyJobsStore.getState().track({
        jobId: started.jobId, wsId: tracked.wsId, graphId: tracked.graphId, branchId: tracked.branchId,
        viewId: tracked.viewId, op: started.op ?? { kind: 'undo', key: tracked.op.key, sourceJobId: tracked.jobId, sourceLabel: label },
        targetLabel: tracked.targetLabel, ...(relationships ? { entityKind: 'edge' as const } : {}),
        startedAt: new Date().toISOString(), job: started,
      })
      notify('success', `Undoing ${label} on your draft — follow it in Property Manager.`)
    } catch (e) {
      if (e instanceof PropertyJobUndoRefusedError && e.code === 'already_undone' && e.jobId) {
        // Undone from elsewhere: the row says so now.
        usePropertyJobsStore.getState().update(tracked.jobId, { ...job, summary: { ...s, undoneBy: e.jobId } })
        notify('info', `${label} was already undone.`)
        return
      }
      throw new Error(undoErrorCopy(e))
    }
  }
  return (
    <>
      <Button size="sm" variant="ghost" leftIcon={Undo2} className="mt-1 h-6 px-2 text-2xs"
        onClick={() => setKey(generateId('propundo'))}>
        Undo
      </Button>
      <DangerConfirmDialog
        isOpen={key !== null}
        title={`Undo ${label}?`}
        subtitle={`Puts back what ${n.toLocaleString()} ${things} held before — on your draft.`}
        confirmPhrase=""
        confirmLabel="Undo"
        sections={[{ label: relationships ? 'Relationships' : 'Entities', count: n, tone: 'warning',
          consequence: 'put back to what they held before the change' }]}
        impactHeading="This will put back"
        irreversibleNote={null}
        caveat="Any changed since are left as they are, and listed. Nothing is published until the draft is."
        onClose={() => setKey(null)}
        onConfirm={confirm}
      />
    </>
  )
}
