/**
 * PropertyJobsPanel — the bulk property changes on this draft: each one being applied, with how
 * far it has got (and a way to stop it), and each one that has ended, with what it did — how many
 * entities changed, which it left alone and which it couldn't change, and why (a file to download).
 * Picked up again after a reload. One this browser lost track of says so, and can be checked
 * again or dismissed.
 */
import { AlertTriangle, CheckCircle2, CircleSlash, Download, Loader2, RotateCw, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useAppNotifications } from '@/components/ui/notifications'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import { cancelPropertyJob, refusedPropertyJobUrl } from '@/services/versioningApiService'
import { jobEnded, usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'
import { propertyJobLabel } from './op/opModel'

export function PropertyJobsPanel({ jobs }: { jobs: readonly TrackedJob[] }) {
  if (jobs.length === 0) return null
  const newestFirst = [...jobs].reverse()
  return (
    <section aria-label="Changes on this draft" className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      <h4 className="px-3.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Changes on this draft</h4>
      <ul className="divide-y divide-glass-border">
        {newestFirst.map((t) => <JobRow key={t.jobId} tracked={t} />)}
      </ul>
      <p className="px-3.5 py-2 text-[10.5px] text-ink-muted bg-black/[0.02] dark:bg-white/[0.02] border-t border-glass-border">
        Applied to your draft — the counts and the catalog above follow it, batch by batch.
      </p>
    </section>
  )
}

function JobRow({ tracked }: { tracked: TrackedJob }) {
  const { notify } = useAppNotifications()
  const job = tracked.job
  const status = job?.status ?? 'pending'
  const ended = jobEnded(tracked)
  // Lost track of: not being followed now (a check again under way follows it).
  const lost = !ended && tracked.lost && !tracked.lost.checking ? tracked.lost : null
  const pct = Math.round(Math.max(0, Math.min(1, job?.progress ?? 0)) * 100)
  const s = job?.summary ?? {}
  // `refused` counts every target not written as asked; of those, the write gate's own refusals
  // are the ones that "couldn't be"; the rest were left alone or weren't in the draft.
  const refused = s.refused?.byReason?.write_refused ?? 0
  const notFound = (s.missing ?? 0) + (s.deletedInDraft ?? 0)
  // A search target's matches the draft had changed so the search no longer matched them.
  const noLonger = s.noLongerMatches ?? 0
  const listed = s.refused?.count ?? 0
  // A change of relationships says so, and the roll-ups it left alone.
  const relationships = tracked.entityKind === 'edge' || job?.entityKind === 'edge'
  const rollups = s.refused?.byReason?.derived ?? 0
  const cancel = () => {
    cancelPropertyJob(tracked.wsId, tracked.graphId, tracked.jobId)
      .then((j) => usePropertyJobsStore.getState().update(tracked.jobId, j))
      .catch((e: unknown) => notify('error', `Couldn’t stop it — ${(e as Error).message}`))
  }
  const Icon = lost ? AlertTriangle : !ended ? Loader2 : status === 'completed' ? (refused ? AlertTriangle : CheckCircle2) : status === 'cancelled' ? CircleSlash : AlertTriangle
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0',
          lost ? 'text-amber-600 dark:text-amber-400'
            : !ended ? 'animate-spin text-accent-lineage'
            : status === 'completed' && !refused ? 'text-emerald-600 dark:text-emerald-400'
              : status === 'cancelled' ? 'text-ink-muted' : 'text-amber-600 dark:text-amber-400')} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink truncate">{propertyJobLabel(tracked.op)}</p>
          <p className="text-[11px] text-ink-muted truncate">On {tracked.targetLabel}</p>
          {lost ? (
            <div className="mt-1 text-[11px] text-ink-secondary" role="status">
              {lost.gone
                ? <>This change can’t be found on the server any more — dismiss it here.</>
                : <>Lost track of this change: {lost.message}. It may still be running on the server.</>}
              {!lost.gone && (
                <Button size="sm" variant="ghost" leftIcon={RotateCw} className="ml-1 h-6 px-2 text-2xs"
                  onClick={() => usePropertyJobsStore.getState().checkAgain([tracked.jobId])}>
                  Check again
                </Button>
              )}
            </div>
          ) : !ended ? (
            <div className="mt-1.5 flex items-center gap-2" aria-live="polite">
              <ProgressBar value={pct} label={`${propertyJobLabel(tracked.op)}: ${pct}%`} className="flex-1" />
              <span className="text-[10.5px] tabular-nums text-ink-muted shrink-0">
                {job?.total ? `${(job.processed ?? 0).toLocaleString()} of ${job.total.toLocaleString()}`
                  : status === 'pending' ? 'Waiting to start'
                    : job?.phase === 'resolve' ? `Finding the ${relationships ? 'relationships' : 'entities'}${job.processed ? ` — ${job.processed.toLocaleString()} so far` : '…'}` : `${pct}%`}
              </span>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-ink-secondary">
              {status === 'failed'
                ? <>Stopped{typeof job?.error === 'string' ? `: ${job.error}` : job?.error?.message ? `: ${job.error.message}` : ''}. </>
                : status === 'cancelled' ? 'Stopped on request. ' : ''}
              <span className="tabular-nums">{(s.changed ?? 0).toLocaleString()}</span>{relationships ? ' relationships' : ''} changed
              {(s.unchanged ?? 0) + (s.conflicts ?? 0) > 0 && <> · <span className="tabular-nums">{((s.unchanged ?? 0) + (s.conflicts ?? 0)).toLocaleString()}</span> left as they were</>}
              {notFound > 0 && <> · <span className="tabular-nums">{notFound.toLocaleString()}</span> not in the draft</>}
              {noLonger > 0 && <> · <span className="tabular-nums">{noLonger.toLocaleString()}</span> no longer matched the search on your draft — left as they are</>}
              {(s.unconvertible ?? 0) > 0 && (
                <> · <span className="tabular-nums text-amber-700 dark:text-amber-300">{(s.unconvertible ?? 0).toLocaleString()}</span>{' '}
                  {tracked.op.onFail === 'remove' ? 'removed — they wouldn’t convert' : 'wouldn’t convert'}</>
              )}
              {rollups > 0 && <> · <span className="tabular-nums">{rollups.toLocaleString()}</span> {rollups === 1 ? 'roll-up' : 'roll-ups'} left alone</>}
              {refused > 0 && <> · <span className="tabular-nums text-amber-700 dark:text-amber-300">{refused.toLocaleString()}</span> couldn’t be</>}
            </p>
          )}
          {/* Its targets were judged as published, not checked again on the draft: why. */}
          {ended && s.recheck?.exact === false && s.recheck.note && (
            <p className="mt-0.5 text-[10.5px] text-ink-muted">{s.recheck.note}</p>
          )}
          {s.publishedCommitId && (
            <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> Published — listed in the publish’s audit
            </p>
          )}
        </div>
        {!ended && !lost && <IconButton icon={Square} label="Stop" detail="What it already changed stays on the draft" size="sm" onClick={cancel} />}
        {(ended || lost) && <IconButton icon={X} label="Dismiss" size="sm" onClick={() => usePropertyJobsStore.getState().dismiss(tracked.jobId)} />}
      </div>
      {ended && listed > 0 && (
        <div className="mt-1.5 pl-6">
          <Button size="sm" variant="ghost" leftIcon={Download} className="h-6 px-2 text-2xs"
            onClick={() => triggerBrowserDownload(refusedPropertyJobUrl(tracked.wsId, tracked.graphId, tracked.jobId), `refused-${tracked.jobId}.csv`)}>
            Which, and why
          </Button>
        </div>
      )}
    </li>
  )
}
