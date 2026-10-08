/**
 * BootstrapProgress — what the user watches while their graph is copied into version
 * history, and the receipt they get afterwards.
 *
 * Four states, one component (so the canvas strip and the data-source card can never
 * disagree — they read the same query):
 *
 *  • running        — named phases with check marks, a live count, a progress bar.
 *  • needs decision — the source uses some identifiers more than once, found before
 *                     anything was copied: what collides, which copy would be kept, the
 *                     full list to download, and (for a manager) collapse / re-check /
 *                     give up. Version history keeps one item per identifier, so someone
 *                     has to choose; we never collapse a customer's data on our own.
 *  • completed      — the INTEGRITY REPORT: what was checked, and the plain statement that
 *                     nothing was lost. This is the whole point of the rewrite: enabling
 *                     version control used to be an act of faith.
 *  • failed         — a plain-language reason, the recovery the failure allows (Resume or
 *                     Start over), Give up, the report to download, and technical details
 *                     for whoever needs them.
 */
import { useState } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, Download,
  Hourglass, Loader2, Merge, RefreshCw, RotateCcw, ShieldCheck, Trash2, Users, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useAppNotifications } from '@/components/ui/notifications'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import {
  BootstrapDecisionError, bootstrapDuplicatesCsvUrl, type BootstrapJob, type BootstrapPhase,
} from '@/services/versioningApiService'
import { useAbandonBootstrap, useDecideBootstrapDuplicates, useRetryBootstrap } from '../hooks/useVersioning'

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

/** When a duplicate copy was last synced — the first thing deciding which copy is kept. */
function syncedAt(iso: string | null): string {
  if (!iso) return 'no sync time'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

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
  const { notify } = useAppNotifications()
  const retry = useRetryBootstrap(wsId, dataSourceId)
  const abandon = useAbandonBootstrap(wsId, dataSourceId)
  const decide = useDecideBootstrapDuplicates(wsId, dataSourceId)
  const openPanel = useVersioningPanelStore((s) => s.openPanel)
  const [showDetails, setShowDetails] = useState(false)
  const [confirming, setConfirming] = useState<null | 'restart' | 'abandon' | 'collapse'>(null)
  // The decision was refused because the list changed under it: say so beside the (refetched) list.
  const [listChanged, setListChanged] = useState(false)

  const running = job.status === 'pending' || job.status === 'running'
  const needsDecision = job.status === 'needs_decision'
  const failed = job.status === 'failed'
  const done = job.status === 'completed'
  const eta = timeLeft(job)
  const active = stepIndex(job.phase)
  const dup = job.duplicates ?? null
  // Who else reads the graph a collapse changes: named in this workspace, counted elsewhere.
  const otherWorkspaces = dup?.sharedWithOtherWorkspaces ?? 0
  const shared = (dup?.sharedWith.length ?? 0) + otherWorkspaces
  // Once a collapse was decided, the source graph may already have lost its extra copies: nothing
  // that runs after (Give up included) puts them back, so the copy must stop promising "untouched".
  // `sourceCollapse` outlives a restart, which re-reads the list (and may find none left).
  const decided = !!dup?.decision || !!job.sourceCollapse
  // Offer only the recovery that can work: resuming an integrity failure fails the same way again,
  // and an internal one is a bug no button fixes. A job from before failures carried an action
  // offers both, as it always did.
  const canResume = !job.failure || job.failure.action === 'resume'
  const canRestart = !job.failure || job.failure.action !== null

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
      onSuccess: () => notify('success', mode === 'resume' ? 'Picking up where it left off…'
        : needsDecision ? 'Checking the source again…' : 'Starting over…'),
      onError: (e) => notify('error', e instanceof Error ? e.message : 'Could not retry.'),
    })

  const runAbandon = () =>
    abandon.mutate(undefined, {
      onSuccess: () => notify('success', decided
        ? 'Cancelled — version control is off for this data source.'
        : 'Cancelled — this data source is exactly as it was.'),
      onError: (e) => notify('error', e instanceof Error ? e.message : 'Could not cancel.'),
    })

  // Sent with the fingerprint of the list the manager was shown, so it can never apply to a list
  // that changed since: the server refuses (`stale_decision`), and the hook refetches the new one.
  const runCollapse = (fingerprint: string) => {
    setListChanged(false)
    decide.mutate(fingerprint, {
      onSuccess: () => notify('success', 'Collapsing the duplicates — the copy carries on.'),
      onError: (e) => {
        if (e instanceof BootstrapDecisionError && e.type === 'stale_decision') setListChanged(true)
        else notify('error', e instanceof Error ? e.message : 'Could not decide.')
      },
    })
  }

  // ── the two-step confirm every destructive action goes through ─────────────
  const confirmBox = confirming && (
    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
      <p className="text-[12px] text-ink leading-relaxed">
        {confirming === 'restart' ? (
          <>
            Starting over throws away the{' '}
            <span className="font-semibold">{num(job.processed)} items</span> already copied
            and begins again from nothing.{' '}
            {canResume ? (
              <>
                <span className="font-semibold">Resuming keeps them</span> and picks up where it
                stopped — try that first unless the source graph has changed.
              </>
            ) : (
              <>Resuming can't fix this one — it would only fail the same way again.</>
            )}
          </>
        ) : confirming === 'collapse' && dup ? (
          <>
            For each of the {num(dup.identifiers)} identifier(s) we keep one copy: the one synced most
            recently (latest lastSyncedAt), then the one with the lowest internal id. The connections of
            the other {num(dup.extraCopies)} move to the kept copy, and{' '}
            <span className="font-semibold">those copies are removed from the source graph</span>
            {shared > 0 && ' — for every data source that reads it'}. Rollups are rebuilt
            afterwards.{' '}
            <span className="font-semibold">Giving up later won't restore them.</span>
          </>
        ) : decided ? (
          <>
            This stops the copy and removes everything it wrote.{' '}
            <span className="font-semibold">Duplicate copies already removed from your data source are
            not put back</span> — otherwise it stays exactly as it is now, just without version control.
          </>
        ) : (
          <>
            This stops the copy and removes everything it wrote.{' '}
            <span className="font-semibold">Your data source is not touched</span> — it stays
            exactly as it is now, just without version control.
          </>
        )}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => {
            const what = confirming
            setConfirming(null)
            if (what === 'restart') runRetry('restart')
            else if (what === 'collapse') { if (dup) runCollapse(dup.fingerprint) }
            else runAbandon()
          }}
          className={cn(
            'px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white shadow-sm transition-colors',
            confirming === 'abandon'
              ? 'bg-rose-600 hover:bg-rose-700'
              : 'bg-amber-600 hover:bg-amber-700',
          )}
        >
          {confirming === 'restart' ? 'Yes, start over'
            : confirming === 'collapse' ? 'Yes, collapse and continue' : 'Yes, remove it'}
        </button>
        <button
          onClick={() => setConfirming(null)}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )

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

      {/* ── needs decision: duplicate identifiers, found before anything was copied ── */}
      {needsDecision && dup && (
        <>
          <div className="flex items-start gap-2.5">
            <Copy className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink leading-snug">Some identifiers are used more than once</p>
              <p className="text-[12px] text-ink-muted leading-snug">
                {num(dup.identifiers)} identifier(s) each belong to more than one item ({num(dup.sameType)} where
                the copies share a type, {num(dup.crossType)} where they don't) —{' '}
                {num(dup.extraCopies)} extra {dup.extraCopies === 1 ? 'copy' : 'copies'} in all. Version history
                keeps one item per identifier, so the copy is paused until a manager decides: collapse them
                here, or fix them in the source and re-check it.
              </p>
              <p className="text-[11px] text-ink-muted mt-1">Nothing has been copied yet.</p>
            </div>
          </div>
          {shared > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
              <Users className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
              <p className="min-w-0 text-[12px] text-ink leading-snug">
                This graph is also read by{' '}
                {dup.sharedWith.length > 0 && (
                  <span className="font-semibold">{dup.sharedWith.map((s) => s.name).join(', ')}</span>
                )}
                {dup.sharedWith.length > 0 && otherWorkspaces > 0 && ' and '}
                {otherWorkspaces > 0 && (
                  <span className="font-semibold">
                    {num(otherWorkspaces)} data source{otherWorkspaces === 1 ? '' : 's'} in other workspaces
                  </span>
                )}.
                Collapsing removes the extra copies for {shared === 1 ? 'it' : 'them'} too.
              </p>
            </div>
          )}
          {listChanged && (
            <p role="alert" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-ink">
              The list changed — review it again before deciding.
            </p>
          )}
          <p className="mt-3 text-[11px] text-ink-muted">
            Of each identifier's copies we keep the one synced most recently, then the one with the lowest
            internal id:
          </p>
          <ul
            className={cn(
              'mt-1.5 overflow-y-auto rounded-lg border border-glass-border divide-y divide-glass-border',
              variant === 'bar' ? 'max-h-28' : 'max-h-48',   // the canvas strip must not swallow the canvas
            )}
          >
            {dup.sample.map((c) => (
              <li key={`${c.urn} ${c.internalId}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink-secondary" title={c.urn}>{c.urn}</span>
                <span className="shrink-0 text-ink-muted">{c.label ?? '—'}</span>
                <span className="shrink-0 text-ink-muted tabular-nums">#{c.internalId}</span>
                <span className="shrink-0 text-ink-muted">{syncedAt(c.lastSyncedAt)}</span>
                <span className="w-9 shrink-0 text-right">
                  {c.kept && (
                    <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      kept
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {dup.sample.length < dup.identifiers + dup.extraCopies && (
              <>Showing {num(dup.sample.length)} of {num(dup.identifiers + dup.extraCopies)} copies · </>
            )}
            <a
              href={bootstrapDuplicatesCsvUrl(wsId, dataSourceId)}
              download={`duplicate-identifiers-${dataSourceId}.csv`}
              className="inline-flex items-center gap-1 font-medium text-accent-lineage hover:underline"
            >
              <Download className="w-3 h-3" /> Download full list (CSV)
            </a>
          </p>
          {canManage && confirmBox}
          {canManage && !confirming && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {/* Collapsing removes data from the customer's own graph — it asks first, and says so. */}
              <button
                onClick={() => setConfirming('collapse')}
                disabled={decide.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {decide.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Merge className="w-3.5 h-3.5" />}
                Collapse {num(dup.extraCopies)} {dup.extraCopies === 1 ? 'duplicate' : 'duplicates'} and continue
              </button>
              {/* Nothing has been copied, so re-reading the source costs nothing worth confirming. */}
              <button
                onClick={() => runRetry('restart')}
                disabled={retry.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors disabled:opacity-60"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Re-check source
              </button>
              <button
                onClick={() => setConfirming('abandon')}
                disabled={abandon.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-rose-500 hover:border-rose-500/30 transition-colors disabled:opacity-60"
              >
                <Trash2 className="w-3.5 h-3.5" /> Give up
              </button>
            </div>
          )}
          {!canManage && (
            <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
              <Hourglass className="w-3.5 h-3.5 shrink-0" />
              Waiting for a workspace manager to decide what happens to the duplicates.
            </p>
          )}
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
          {(job.collapsed?.nodes ?? 0) > 0 && (
            <p className="mt-1 text-[11px] text-ink-muted">
              {num(job.collapsed!.nodes)} duplicate item(s) were collapsed into the copy kept for their
              identifier, as decided — their connections moved to it.
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
              <p className="text-sm font-semibold text-ink leading-snug">
                {decided ? 'We stopped before switching it on' : 'We stopped before changing anything'}
              </p>
              <p className="text-[12px] text-ink-muted leading-snug">
                {job.error ?? 'The copy did not match the source graph.'}
              </p>
              <p className="text-[11px] text-ink-muted/80 mt-1">
                {decided
                  ? 'This data source still reads as it did — except that duplicate copies you chose to collapse may already have been removed.'
                  : 'This data source is untouched and still reads exactly as it did.'}
              </p>
            </div>
          </div>
          {canManage && confirmBox}
          {canManage && !confirming && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {canResume && (
                <button
                  onClick={() => runRetry('resume')}
                  disabled={retry.isPending}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
                >
                  {retry.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  Resume
                </button>
              )}
              {/* Both of these DESTROY work, and they sit next to the safe one. They ask first —
                  and say what they will cost, in the numbers this job actually has. */}
              {canRestart && (
                <button
                  onClick={() => setConfirming('restart')}
                  disabled={retry.isPending}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] disabled:opacity-60',
                    canResume
                      ? 'font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors'
                      : 'font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm',
                  )}
                >
                  Start over
                </button>
              )}
              <button
                onClick={() => setConfirming('abandon')}
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
