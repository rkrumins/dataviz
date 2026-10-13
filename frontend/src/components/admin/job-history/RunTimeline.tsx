/**
 * A run's life on one line: queued, started, finished — and how long each
 * part took.
 *
 * The gap between created and started is the wait for a worker; between
 * started and finished, the work. Both are the first questions about a slow
 * run ("did it queue, or did it grind?"), so each span is written on its
 * segment. A run still going counts up on the page's shared clock, and its
 * last checkpoint pulses beside it. Each stop is a calendar time ("Today
 * 09:41"), not "3 h ago" three times over; exact on hover.
 */
import { cn } from '@/lib/utils'
import { formatSpan, toUtcDate } from '@/lib/smartTime'
import { useNow } from '@/lib/useNow'
import { DateTime } from '@/components/ui/DateTime'
import type { AggregationJobResponse } from '@/services/aggregationService'

type Tone = 'muted' | 'accent' | 'success' | 'danger' | 'warning'

const DOT: Record<Tone, string> = {
    muted: 'bg-black/25 dark:bg-white/30',
    accent: 'bg-indigo-500',
    success: 'bg-emerald-500',
    danger: 'bg-red-500',
    warning: 'bg-amber-500',
}

const END: Record<string, { label: string; tone: Tone }> = {
    completed: { label: 'Completed', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'warning' },
}

/** Live spans move with a clock that ticks twice a minute: say minutes. */
function liveSpan(ms: number): string {
    return ms < 60_000 ? 'under a minute' : formatSpan(Math.floor(ms / 60_000) * 60_000)
}

function Stop({ label, at, tone, live = false }: {
    label: string
    at: string | null | undefined
    tone: Tone
    live?: boolean
}) {
    return (
        <li className="relative flex min-w-0 flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
                <span className="relative grid h-2.5 w-2.5 place-items-center">
                    {live && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[tone])} />}
                    <span className={cn('relative h-2 w-2 rounded-full ring-2 ring-canvas', DOT[tone])} />
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">{label}</span>
            </span>
            <span className="pl-4 text-[11px] font-medium text-ink">
                {at ? <DateTime at={at} variant="calendar" /> : <span className="text-ink-muted">{live ? 'now' : '—'}</span>}
            </span>
        </li>
    )
}

function Segment({ text, live = false }: { text: string | null; live?: boolean }) {
    return (
        <li aria-hidden={!text} className="flex min-w-[4.5rem] flex-1 flex-col items-center justify-start pt-[3px]">
            <span className={cn(
                'h-px w-full',
                live ? 'animate-pulse bg-indigo-500/50' : 'bg-black/[0.12] dark:bg-white/[0.14]',
            )} />
            {text && <span className="mt-1 whitespace-nowrap text-[10px] tabular-nums text-ink-muted">{text}</span>}
        </li>
    )
}

export function RunTimeline({ job, className }: { job: AggregationJobResponse; className?: string }) {
    const now = useNow()
    const created = toUtcDate(job.createdAt)?.getTime()
    const started = toUtcDate(job.startedAt)?.getTime()
    const ended = toUtcDate(job.completedAt)?.getTime()
    const running = job.status === 'running'
    const pending = job.status === 'pending'
    const end = END[job.status] ?? { label: 'Ended', tone: 'muted' as Tone }

    const wait = created != null && started != null
        ? `waited ${formatSpan(started - created)}`
        : pending && created != null ? `waiting ${liveSpan(now - created)}` : null
    const work = started != null && ended != null
        ? `ran ${formatSpan(ended - started)}`
        : running && started != null ? `running ${liveSpan(now - started)}` : null

    return (
        <div className={cn('flex flex-wrap items-start gap-x-4 gap-y-2', className)}>
            <ol aria-label="Run timeline" className="flex min-w-0 flex-1 items-start gap-2">
                <Stop label="Created" at={job.createdAt} tone="muted" />
                <Segment text={wait} live={pending} />
                <Stop label="Started" at={job.startedAt} tone={job.startedAt ? 'accent' : 'muted'} live={pending} />
                <Segment text={work} live={running} />
                {running ? (
                    <Stop label="Running" at={null} tone="accent" live />
                ) : (
                    <Stop label={pending ? 'Finish' : end.label} at={job.completedAt} tone={pending ? 'muted' : end.tone} />
                )}
            </ol>
            {job.lastCheckpointAt && running && (
                <span className="flex shrink-0 items-center gap-1.5 self-center rounded-full bg-emerald-500/[0.08] px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    <DateTime at={job.lastCheckpointAt} prefix="Checkpoint " />
                </span>
            )}
        </div>
    )
}
