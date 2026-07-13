/**
 * BootstrapJobsPanel — "enable version control" copies, which no other panel can show.
 *
 * A bootstrapping graph deliberately parks its projection watermark, so that the projector
 * never drops the pinned SOURCE graph mid-copy. The side effect is that the graph reads as
 * idle and lag-free to the projection probe — a 7.7M-entity copy grinding for an hour, or one
 * that FAILED days ago and is silently blocking writes to that data source, both count as
 * "fresh" there. This panel is the only place either is visible.
 *
 * It renders nothing at all when there is nothing to say: no jobs, or only completed ones.
 * An ops surface that shouts on a quiet day teaches people to ignore it.
 */
import { AlertTriangle, GitBranch, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { BootstrapJobEntry, BootstrapJobsSection } from '@/services/systemStatusService'

const pct = (j: BootstrapJobEntry) =>
    j.total > 0 ? Math.min(100, Math.round((j.processed / j.total) * 100)) : 0

function JobRow({ j, stalled }: { j: BootstrapJobEntry; stalled: boolean }) {
    const bad = j.status === 'failed' || stalled
    return (
        <div
            className={cn(
                'rounded-xl border px-3 py-2.5',
                bad
                    ? 'border-rose-500/30 bg-rose-500/[0.05]'
                    : 'border-glass-border bg-canvas-overlay/40',
            )}
        >
            <div className="flex items-center gap-2 min-w-0">
                {bad ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                ) : (
                    <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin shrink-0" />
                )}
                <span className="text-[12px] font-medium text-ink truncate">
                    {j.dataSourceId ?? j.graphId}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-muted font-mono">
                    {j.status}
                    {j.phase ? ` · ${j.phase}` : ''}
                </span>
            </div>

            {j.total > 0 && (
                <>
                    <ProgressBar
                        value={pct(j)}
                        label={`Copying ${j.dataSourceId ?? j.graphId}`}
                        className="mt-2"
                        barClassName={bad ? 'bg-rose-500' : undefined}
                    />
                    <p className="mt-1 text-[11px] text-ink-muted">
                        {j.processed.toLocaleString()} of {j.total.toLocaleString()} entities
                        {j.workspaceId ? ` · ${j.workspaceId}` : ''}
                    </p>
                </>
            )}

            {/* The two things an on-call actually needs: why it stopped, and that it is safe. */}
            {j.status === 'failed' && j.error && (
                <p className="mt-1.5 text-[11px] text-rose-500 break-words">{j.error}</p>
            )}
            {j.status === 'failed' && (
                <p className="mt-1 text-[11px] text-ink-muted">
                    Writes to this data source stay blocked until someone resumes or abandons it.
                </p>
            )}
            {stalled && (
                <p className="mt-1.5 text-[11px] text-rose-500">
                    No heartbeat — no worker has picked this up. Check the versioning worker.
                </p>
            )}
        </div>
    )
}

export function BootstrapJobsPanel({ jobs }: { jobs: BootstrapJobsSection | null }) {
    if (!jobs) return null
    const live = jobs.jobs.filter(
        (j) => j.status === 'running' || j.status === 'pending' || j.status === 'failed',
    )
    if (live.length === 0) return null

    const bad = jobs.failed > 0 || jobs.stalled > 0

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
            <div className="flex items-center gap-3">
                <div
                    className={cn(
                        'w-9 h-9 rounded-xl flex items-center justify-center border shrink-0',
                        bad
                            ? 'bg-rose-500/10 border-rose-500/20'
                            : 'bg-gradient-to-br from-indigo-500/15 to-violet-600/10 border-indigo-500/20',
                    )}
                >
                    <GitBranch className={cn('w-4.5 h-4.5', bad ? 'text-rose-500' : 'text-indigo-500')} />
                </div>
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink tracking-tight">
                        Enabling version control
                    </h3>
                    <p className="text-[11px] text-ink-muted">
                        {jobs.running > 0 && `${jobs.running} copying`}
                        {jobs.running > 0 && (jobs.failed > 0 || jobs.stalled > 0) && ' · '}
                        {jobs.failed > 0 && `${jobs.failed} failed`}
                        {jobs.failed > 0 && jobs.stalled > 0 && ' · '}
                        {jobs.stalled > 0 && `${jobs.stalled} with no heartbeat`}
                    </p>
                </div>
            </div>

            <div className="mt-4 space-y-2">
                {live.map((j) => (
                    <JobRow
                        key={j.jobId}
                        j={j}
                        // A running job whose heartbeat has aged out is the tier being dead, not
                        // this job being slow — the worker heartbeats on a timer, not on progress.
                        stalled={j.status === 'running' && jobs.stalled > 0}
                    />
                ))}
            </div>
        </section>
    )
}
