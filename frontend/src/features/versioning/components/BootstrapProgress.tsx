/**
 * BootstrapProgress — what the user watches while their graph is copied into version
 * history, and the receipt they get afterwards.
 *
 * Three states, one component (so the canvas strip and the data-source card can never
 * disagree — they read the same query):
 *
 *  • running   — named phases with check marks, a live count, a progress bar.
 *  • completed — the INTEGRITY REPORT: what was checked, and the plain statement that
 *                nothing was lost. This is the whole point of the rewrite: enabling
 *                version control used to be an act of faith.
 *  • failed    — a plain-language reason, Resume / Start over / Give up, the report
 *                to download, and technical details for whoever needs them.
 */
import { useState } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Download,
  Loader2, RotateCcw, ShieldCheck, Trash2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/toast'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import type { BootstrapJob, BootstrapPhase } from '@/services/versioningApiService'
import { useAbandonBootstrap, useRetryBootstrap } from '../hooks/useVersioning'

/** The job's eight phases, told as the four things a person actually cares about. */
const STEPS: Array<{ id: string; label: string; phases: BootstrapPhase[] }> = [
  { id: 'read', label: 'Reading the graph', phases: ['counting', 'nodes', 'edges'] },
  { id: 'check', label: 'Checking every item', phases: ['validate'] },
  { id: 'write', label: 'Writing history', phases: ['heads', 'merkle'] },
  { id: 'finish', label: 'Finishing up', phases: ['finalize', 'backfill'] },
]

function stepIndex(phase: BootstrapPhase | null): number {
  if (!phase) return 0
  const i = STEPS.findIndex((s) => s.phases.includes(phase))
  return i < 0 ? 0 : i
}

const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString() : '—')

/** Phases where the item counter actually advances — the only ones we can honestly time. */
const COUNTING_PHASES: BootstrapPhase[] = ['nodes', 'edges']

/**
 * "About 12 minutes left", from the throughput we have actually observed on this job.
 *
 * Deliberately narrow. Only the two scanning phases move the item counter, so only they can
 * be timed; during checking/writing/finishing the counter is frozen and any "estimate" would
 * be a number we invented. A large graph really can take the better part of an hour, and a
 * bare percentage leaves someone unable to decide whether to wait or come back after lunch —
 * but a confidently wrong ETA is worse than none, so we return null rather than guess.
 */
function timeLeft(job: BootstrapJob): string | null {
  if (job.status !== 'running' || !job.phase || !COUNTING_PHASES.includes(job.phase)) return null
  if (!job.startedAt || job.processed <= 0 || job.total <= job.processed) return null
  const elapsedMs = Date.now() - new Date(job.startedAt).getTime()
  if (!Number.isFinite(elapsedMs) || elapsedMs < 30_000) return null   // too early to be honest
  const perMs = job.processed / elapsedMs
  const mins = Math.round((job.total - job.processed) / perMs / 60_000)
  if (!Number.isFinite(mins) || mins < 1) return 'less than a minute left'
  if (mins === 1) return 'about a minute left'
  if (mins < 60) return `about ${mins} minutes left`
  const hrs = Math.round(mins / 60)
  return hrs === 1 ? 'about an hour left' : `about ${hrs} hours left`
}

export function BootstrapProgress({
  job, wsId, dataSourceId, variant = 'bar', canManage = true, onDismiss,
}: {
  job: BootstrapJob
  wsId: string
  dataSourceId: string
  /** `bar` = the canvas strip; `card` = the data-source panel. */
  variant?: 'bar' | 'card'
  canManage?: boolean
  /** Close the completed report and hand over to the normal versioning UI. */
  onDismiss?: () => void
}) {
  const { showToast } = useToast()
  const retry = useRetryBootstrap(wsId, dataSourceId)
  const abandon = useAbandonBootstrap(wsId, dataSourceId)
  const openPanel = useVersioningPanelStore((s) => s.openPanel)
  const [showDetails, setShowDetails] = useState(false)

  const running = job.status === 'pending' || job.status === 'running'
  const failed = job.status === 'failed'
  const done = job.status === 'completed'
  const eta = timeLeft(job)
  const active = stepIndex(job.phase)

  const downloadReport = () => {
    const blob = new Blob([JSON.stringify(job.report ?? job, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `version-control-report-${dataSourceId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const runRetry = (mode: 'resume' | 'restart') =>
    retry.mutate(mode, {
      onSuccess: () => showToast('success', mode === 'resume' ? 'Picking up where it left off…' : 'Starting over…'),
      onError: (e) => showToast('error', e instanceof Error ? e.message : 'Could not retry.'),
    })

  const runAbandon = () =>
    abandon.mutate(undefined, {
      onSuccess: () => showToast('success', 'Cancelled — this data source is exactly as it was.'),
      onError: (e) => showToast('error', e instanceof Error ? e.message : 'Could not cancel.'),
    })

  // ── running ───────────────────────────────────────────────────────────────
  const body = (
    <>
      {running && (
        <>
          <div className="flex items-center gap-2.5 flex-wrap">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  'inline-flex items-center gap-1.5 text-[11px] font-medium',
                  i < active ? 'text-emerald-600 dark:text-emerald-400'
                    : i === active ? 'text-ink' : 'text-ink-muted/50',
                )}
              >
                {i < active ? (
                  <Check className="w-3.5 h-3.5" />
                ) : i === active ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-current opacity-40" />
                )}
                {s.label}
              </span>
            ))}
          </div>
          <ProgressBar
            value={job.percent}
            label="Copying the graph into version history"
            className={variant === 'bar' ? 'mt-2' : 'mt-3'}
          />
          {/* Politely announced, not asserted: a job this long would otherwise be entirely
              silent to a screen reader, but it must not interrupt what the user is doing. */}
          <p className="mt-1.5 text-[11px] text-ink-muted" aria-live="polite" aria-atomic="true">
            {job.total > 0
              ? <>{num(job.processed)} of {num(job.total)} items copied</>
              : <>Working out how big this graph is…</>}
            {job.status === 'pending' && ' · queued'}
            {eta && <> · <span className="text-ink-secondary">{eta}</span></>}
          </p>
        </>
      )}

      {/* ── completed: the integrity report ─────────────────────────────────── */}
      {done && job.report && (
        <>
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink leading-snug">Everything checked out</p>
              <p className="text-[12px] text-ink-muted leading-snug">
                Your graph is now under version control — and we verified the copy against the source
                before switching it on.
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-1.5">
            {job.report.checks.filter((c) => c.ok).map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-[12px] text-ink-secondary">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                <span className="min-w-0">{c.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
            Zero data loss — every item and connection in the source is in your history.
          </p>
          {job.report.mergedDuplicateConnections > 0 && (
            <p className="mt-1 text-[11px] text-ink-muted">
              {num(job.report.mergedDuplicateConnections)} duplicate connection(s) were merged (same type
              between the same two items — the graph reads identically).
            </p>
          )}
          {(job.report.skippedWithoutIdentifier?.nodes ?? 0) > 0 && (
            <p className="mt-1 text-[11px] text-ink-muted">
              {num(job.report.skippedWithoutIdentifier!.nodes)} item(s) in the source have no identifier.
              They don't appear anywhere in this app, so they weren't copied.
            </p>
          )}
          {job.report.merkle === 'deferred' && (
            <p className="mt-1 text-[11px] text-ink-muted">
              The integrity fingerprint is deferred for a graph this large; the checks above still ran in full.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => openPanel('history')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-accent-lineage border border-accent-lineage/30 bg-accent-lineage/[0.06] hover:bg-accent-lineage/10 transition-colors"
            >
              View history
            </button>
            <button
              onClick={downloadReport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Report
            </button>
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
              >
                Done
              </button>
            )}
          </div>
        </>
      )}

      {/* ── failed ───────────────────────────────────────────────────────────── */}
      {failed && (
        <>
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink leading-snug">We stopped before changing anything</p>
              <p className="text-[12px] text-ink-muted leading-snug">
                {job.error ?? 'The copy did not match the source graph.'}
              </p>
              <p className="text-[11px] text-ink-muted/80 mt-1">
                This data source is untouched and still reads exactly as it did.
              </p>
            </div>
          </div>
          {canManage && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => runRetry('resume')}
                disabled={retry.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {retry.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Resume
              </button>
              <button
                onClick={() => runRetry('restart')}
                disabled={retry.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors disabled:opacity-60"
              >
                Start over
              </button>
              <button
                onClick={runAbandon}
                disabled={abandon.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-rose-500 hover:border-rose-500/30 transition-colors disabled:opacity-60"
              >
                <Trash2 className="w-3.5 h-3.5" /> Give up
              </button>
              {job.report && (
                <button
                  onClick={downloadReport}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors"
                >
                  <Download className="w-3.5 h-3.5" /> Report
                </button>
              )}
            </div>
          )}
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
          >
            {showDetails ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Technical details
          </button>
          {showDetails && (
            <div className="mt-2 rounded-lg bg-canvas-overlay/50 p-2.5 text-[11px] text-ink-muted font-mono break-words space-y-1">
              <p>job {job.jobId} · phase {job.phase ?? '—'} · {num(job.processed)}/{num(job.total)}</p>
              {(job.report?.checks ?? []).filter((c) => !c.ok).map((c) => (
                <p key={c.key} className="text-rose-500">{c.key}: {c.detail}</p>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )

  if (variant === 'card') {
    return (
      <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">{body}</div>
    )
  }
  return (
    <div className="relative px-4 py-2.5 border-b border-glass-border bg-gradient-to-r from-accent-lineage/[0.07] via-canvas-elevated/40 to-transparent shrink-0">
      {done && onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute top-2 right-3 p-1 rounded-lg text-ink-muted/50 hover:text-ink hover:bg-canvas-overlay transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {body}
    </div>
  )
}
