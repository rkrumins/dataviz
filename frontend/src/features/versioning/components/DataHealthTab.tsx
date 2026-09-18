/**
 * DataHealthTab — the manager-only "Data health" surface in the versioning slide-over.
 *
 * Business-plain throughout: the source of truth (Postgres) and the fast read layer (FalkorDB)
 * are never named by their technology outside the "Technical details" disclosures. Three calm
 * cards: (1) a status hero deriving ONE plain-language state from the full watermark (in sync /
 * catching up / rebuilding with live progress / attention needed with the recorded reason),
 * (2) an on-demand sync check with a drift breakdown, and (3) a confirmed rebuild that always
 * converges to a terminal state — done (auto-verified) or failed (reason + Retry) — instead of
 * spinning forever. Driven by the two projection mutations plus the watermark poll (forced
 * while a rebuild is being watched, so the terminal transition is never missed).
 */
import { useEffect, useRef, useState } from 'react'
import {
  Loader2, CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight, RefreshCw, RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { DriftReport, Watermark } from '@/services/versioningApiService'
import { useProjectionWatermark, useReconcileProjection, useRebuildProjection } from '../hooks/useVersioning'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** "1.2s" / "840ms" — no deps, just enough precision for an operator footnote. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Coarse relative time for the "Checked …" footnote (the report is produced on click, so this is
 *  "just now" almost always — it only ages if the panel stays open). */
function relativeTime(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

type HeroState = 'loading' | 'inSync' | 'catchingUp' | 'rebuilding' | 'failed' | 'behind'

function heroState(wm: Watermark | undefined): HeroState {
  if (!wm) return 'loading'
  if (wm.status === 'rebuilding') return 'rebuilding'
  if (wm.status === 'projecting') return 'catchingUp'
  if (wm.fresh) return 'inSync'
  return wm.lastError ? 'failed' : 'behind'
}

export function DataHealthTab({ wsId, graphId }: { wsId: string; graphId: string }) {
  const { notify } = useAppNotifications()

  // Rebuild lifecycle: 'running' once we've kicked one; terminal 'done' (fresh again after
  // observed progress) or 'failed' (idle + behind, with the recorded reason when there is one).
  const [rebuildPhase, setRebuildPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [failReason, setFailReason] = useState<string | null>(null)
  const [verified, setVerified] = useState<DriftReport | null>(null)
  const sawProgress = useRef(false)
  const idleTicks = useRef(0)

  // Force the poll while we're watching a rebuild: the status-gated poll stops the moment the
  // backend resets to idle, which is exactly the tick that carries the failure reason.
  const wmQ = useProjectionWatermark(wsId, graphId, { force: rebuildPhase === 'running' })
  const wm = wmQ.data

  const reconcile = useReconcileProjection(wsId, graphId)
  const rebuild = useRebuildProjection(wsId, graphId)
  const { mutate: runReconcile } = reconcile

  const [deep, setDeep] = useState(false)
  const [report, setReport] = useState<DriftReport | null>(null)
  const [showTechnical, setShowTechnical] = useState(false)
  const [showFailTechnical, setShowFailTechnical] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)

  // Terminal-state watcher. Keyed on dataUpdatedAt (not just wm) because react-query's
  // structural sharing keeps an identical payload referentially stable — without it, repeated
  // "idle & behind & no reason" polls would only ever count one grace tick.
  useEffect(() => {
    if (rebuildPhase !== 'running' || !wm) return
    const isActive = wm.status === 'projecting' || wm.status === 'rebuilding'
    if (isActive || wm.fresh === false) sawProgress.current = true
    if (isActive) {
      idleTicks.current = 0
      return
    }
    if (sawProgress.current && wm.fresh) {
      setRebuildPhase('done')
      // Auto-verify: one shallow check so "done" means VERIFIED in sync, not just caught up.
      // Best-effort — a concurrent check (409) or a blip must not un-done the rebuild.
      runReconcile({ deep: false }, { onSuccess: (r) => setVerified(r), onError: () => {} })
      return
    }
    if (wm.fresh === false && wm.lastError) {
      setFailReason(wm.lastError)
      setRebuildPhase('failed')
      return
    }
    if (wm.fresh === false && sawProgress.current) {
      // Idle, still behind, no recorded reason — allow a couple of poll ticks of grace
      // (worker handoff), then call it: something stopped the rebuild without a trace.
      idleTicks.current += 1
      if (idleTicks.current >= 3) {
        setFailReason(null)
        setRebuildPhase('failed')
      }
    }
  }, [rebuildPhase, wm, wmQ.dataUpdatedAt, runReconcile])

  const runCheck = () => {
    reconcile.mutate(
      { deep },
      {
        onSuccess: (r) => {
          setReport(r)
          setShowTechnical(false)
        },
        onError: (e) => {
          const msg = (e as Error).message
          notify(/already running/i.test(msg) ? 'info' : 'error',
            /already running/i.test(msg) ? 'A sync check is already running.' : msg)
        },
      },
    )
  }

  const doRebuild = () => {
    setConfirmRebuild(false)
    rebuild.mutate(undefined, {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          notify('info', 'A rebuild is already in progress.')
          return
        }
        // The drift snapshot is now being repaired — drop it so we never show pre-rebuild drift.
        setReport(null)
        setVerified(null)
        setFailReason(null)
        sawProgress.current = false
        idleTicks.current = 0
        setRebuildPhase('running')
      },
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  const driftLines = report && !report.skippedReason && !report.inSync
    ? [
        report.missingNodes.length && `${plural(report.missingNodes.length, 'item', 'items')} missing from the fast read layer`,
        report.extraNodes.length && `${plural(report.extraNodes.length, 'item', 'items')} that shouldn't be there`,
        report.mismatched.length && `${plural(report.mismatched.length, 'item', 'items')} with differences`,
        report.missingEdges.length && `${plural(report.missingEdges.length, 'connection', 'connections')} missing`,
        report.extraEdges.length && `${plural(report.extraEdges.length, 'connection', 'connections')} that shouldn't be there`,
      ].filter(Boolean) as string[]
    : []

  const state = heroState(wm)
  const progressTotal = wm?.progressTotal ?? 0
  const progressDone = Math.min(wm?.progressDone ?? 0, progressTotal)
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : null

  return (
    <div className="space-y-4">
      {/* 1 — Status hero: ONE plain-language answer to "is my data healthy?" */}
      <section
        className={cn(
          'rounded-xl border p-4 transition-colors',
          state === 'inSync' && 'border-emerald-500/30 bg-emerald-500/[0.05]',
          state === 'failed' && 'border-red-500/30 bg-red-500/[0.05]',
          state === 'behind' && 'border-amber-500/30 bg-amber-500/[0.05]',
          (state === 'loading' || state === 'catchingUp' || state === 'rebuilding') &&
            'border-glass-border bg-canvas-elevated/40',
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border',
              state === 'inSync' && 'bg-emerald-500/10 border-emerald-500/20',
              state === 'failed' && 'bg-red-500/10 border-red-500/20',
              state === 'behind' && 'bg-amber-500/10 border-amber-500/20',
              (state === 'loading' || state === 'catchingUp' || state === 'rebuilding') &&
                'bg-canvas-overlay/60 border-glass-border',
            )}
          >
            {state === 'inSync' ? (
              <CheckCircle2 className="w-4.5 h-4.5 text-emerald-600 dark:text-emerald-400" />
            ) : state === 'failed' ? (
              <AlertTriangle className="w-4.5 h-4.5 text-red-600 dark:text-red-400" />
            ) : state === 'behind' ? (
              <AlertTriangle className="w-4.5 h-4.5 text-amber-600 dark:text-amber-400" />
            ) : (
              <Loader2 className="w-4.5 h-4.5 animate-spin text-ink-muted" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-ink font-display tracking-tight">
              {state === 'loading' && 'Checking data health…'}
              {state === 'inSync' && 'Everything is in sync'}
              {state === 'catchingUp' && 'Catching up…'}
              {state === 'rebuilding' && 'Rebuilding the fast read layer…'}
              {state === 'behind' && 'The fast read layer is behind'}
              {state === 'failed' && 'Attention needed'}
            </h3>
            <p className="mt-1 text-[12px] text-ink-muted leading-relaxed">
              {state === 'inSync' && (verified?.inSync
                ? `Verified just now — ${plural(verified.pgNodes, 'item', 'items')} and ${plural(verified.pgEdges, 'connection', 'connections')} checked.`
                : 'Everyone sees the latest published data.')}
              {state === 'catchingUp' && 'A recent change is being applied to the fast read layer. This usually takes seconds.'}
              {state === 'rebuilding' && (progressPct !== null
                ? `${progressDone.toLocaleString()} of ${progressTotal.toLocaleString()} items rebuilt.`
                : 'Replaying everything from the source of truth. Large models can take a few minutes.')}
              {state === 'behind' && 'Reads fall back to the source of truth (slower but always correct). Rebuild to restore fast reads.'}
              {state === 'failed' && 'The last refresh could not finish. Your data is safe in the source of truth — rebuild to repair fast reads.'}
              {state === 'loading' && ' '}
            </p>

            {state === 'rebuilding' && progressPct !== null && (
              <ProgressBar value={progressPct} label="Rebuilding the fast read layer" className="mt-2.5" />
            )}

            <p className="mt-2 text-[11px] text-ink-muted/70">
              Published version <span className="font-semibold text-ink-muted">#{wm?.committed ?? '—'}</span>
              {' · '}
              Fast read layer at <span className="font-semibold text-ink-muted">#{wm?.projected ?? '—'}</span>
            </p>

            {state === 'failed' && (
              <>
                <button
                  onClick={() => setShowFailTechnical((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                >
                  {showFailTechnical ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  Technical details
                </button>
                {showFailTechnical && (
                  <div className="mt-2 rounded-lg bg-canvas-overlay/50 p-2.5 text-[11px] text-ink-muted font-mono break-words space-y-1">
                    <p>{wm?.lastError ?? 'no error recorded'}</p>
                    <p className="text-ink-muted/70">
                      committed #{wm?.committed ?? '—'} · projected #{wm?.projected ?? '—'} · target #{wm?.target ?? '—'}
                      {wm?.lastProjectedAt ? ` · last success ${wm.lastProjectedAt}` : ''}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      {/* 2 — Check sync */}
      <section className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink font-display tracking-tight">Check sync</h3>
            <p className="mt-1 text-[12px] text-ink-muted">
              Confirm the fast read layer matches the source of truth.
            </p>
          </div>
          <button
            onClick={runCheck}
            disabled={reconcile.isPending}
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              'bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20 disabled:opacity-60',
            )}
          >
            {reconcile.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Check sync
          </button>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-muted cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={deep}
            onChange={(e) => setDeep(e.target.checked)}
            className="rounded border-glass-border accent-accent-lineage"
          />
          Deep check (compares every field — slower)
        </label>

        {report && (
          <div className="mt-3">
            {report.skippedReason ? (
              <div className="flex items-start gap-2 rounded-lg border border-glass-border bg-canvas-overlay/40 px-3 py-2.5 text-[12px] text-ink-muted">
                <Info className="w-4 h-4 shrink-0 mt-0.5 text-ink-muted" />
                <span>
                  {report.skippedReason === 'projection in flight'
                    ? 'A refresh is in progress — try again in a moment.'
                    : 'This data source has no fast read layer yet.'}
                </span>
              </div>
            ) : report.inSync ? (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2.5 text-[12px] text-ink">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                <span>
                  The fast read layer matches the source of truth — {plural(report.pgNodes, 'item', 'items')} and{' '}
                  {plural(report.pgEdges, 'connection', 'connections')} checked.
                </span>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                      The fast read layer is out of date.
                    </p>
                    <ul className="mt-1 space-y-0.5 text-[12px] text-ink-muted list-disc list-inside">
                      {driftLines.length > 0
                        ? driftLines.map((l) => <li key={l}>{l}</li>)
                        : <li>Some records don't match the source of truth.</li>}
                    </ul>
                  </div>
                </div>

                <button
                  onClick={() => setShowTechnical((v) => !v)}
                  className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                >
                  {showTechnical ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  Technical details
                </button>
                {showTechnical && (
                  <div className="mt-2 space-y-2.5 rounded-lg bg-canvas-overlay/50 p-2.5 text-[11px] text-ink-muted">
                    <TechList title="Missing items" items={report.missingNodes.map(nodeLabel)} />
                    <TechList title="Unexpected items" items={report.extraNodes.map(nodeLabel)} />
                    {report.mismatched.length > 0 && (
                      <div>
                        <p className="font-semibold text-ink-muted/90 mb-1">Field differences</p>
                        <ul className="space-y-0.5 font-mono">
                          {report.mismatched.map((m, i) => (
                            <li key={`${m.entityId}-${m.field}-${i}`} className="truncate">
                              {m.entityId} · {m.field}: source of truth {fmtVal(m.pg)} → fast read layer {fmtVal(m.falkor)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <TechList title="Missing connections" items={report.missingEdges} mono />
                    <TechList title="Unexpected connections" items={report.extraEdges} mono />
                    {report.truncated && <p className="italic">…and more not shown.</p>}
                  </div>
                )}

                <button
                  onClick={() => setConfirmRebuild(true)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Rebuild
                </button>
              </div>
            )}

            {!report.skippedReason && (
              <p className="mt-2 text-[11px] text-ink-muted/70">
                Checked {relativeTime(report.checkedAt)} · {formatDuration(report.durationMs)}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 3 — Rebuild */}
      <section className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">
        <h3 className="text-sm font-semibold text-ink font-display tracking-tight">Rebuild fast read layer</h3>
        <p className="mt-1 text-[12px] text-ink-muted">
          Replays the fast read layer from the source of truth. Use it when a sync check finds differences.
        </p>
        <button
          onClick={() => setConfirmRebuild(true)}
          disabled={rebuild.isPending || rebuildPhase === 'running'}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/10 transition-colors disabled:opacity-60"
        >
          {rebuild.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          Rebuild fast read layer
        </button>

        {rebuildPhase === 'running' && (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            {progressPct !== null
              ? `Rebuilding… ${progressDone.toLocaleString()} of ${progressTotal.toLocaleString()} items`
              : 'Rebuilding… this can take a few minutes for large models.'}
          </div>
        )}
        {rebuildPhase === 'done' && (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
            {verified?.inSync ? (
              <>
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                Rebuilt and verified — {plural(verified.pgNodes, 'item', 'items')} and {plural(verified.pgEdges, 'connection', 'connections')} checked.
              </>
            ) : (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Up to date
              </>
            )}
          </div>
        )}
        {rebuildPhase === 'failed' && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-red-700 dark:text-red-300">
                  The rebuild couldn't finish.
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {failReason
                    ? 'Nothing was lost — the source of truth is untouched. Fix the issue below, then retry.'
                    : 'It stopped without recording a reason. Nothing was lost — retry, and check the service logs if it happens again.'}
                </p>
                {failReason && (
                  <p className="mt-1.5 rounded bg-canvas-overlay/60 px-2 py-1 text-[11px] font-mono text-ink-muted break-words">
                    {failReason}
                  </p>
                )}
                <button
                  onClick={doRebuild}
                  className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry rebuild
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <Backdrop open={confirmRebuild} onClick={() => setConfirmRebuild(false)} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      {confirmRebuild && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in pointer-events-auto">
            <div className="px-6 pt-6 pb-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20 shrink-0">
                <RotateCcw className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <h3 className="text-base font-semibold text-ink tracking-tight">Rebuild the fast read layer?</h3>
            </div>
            <p className="px-6 pb-5 text-[13px] text-ink-muted leading-relaxed">
              This rebuilds the fast read layer from the source of truth. <span className="font-semibold text-ink">No data is lost</span> —
              everyone keeps working from the source of truth while it rebuilds.
            </p>
            <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
              <button
                onClick={() => setConfirmRebuild(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={doRebuild}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <RotateCcw className="w-4 h-4" />
                Rebuild
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const nodeLabel = (n: { entityId: string; urn?: string | null; displayName?: string | null }) =>
  n.displayName ? `${n.displayName} (${n.entityId})` : n.urn ? `${n.urn} (${n.entityId})` : n.entityId

const fmtVal = (v: unknown) => (v === null || v === undefined ? '∅' : JSON.stringify(v))

/** A labelled, bounded list inside the technical disclosure; renders nothing when empty. */
function TechList({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="font-semibold text-ink-muted/90 mb-1">{title}</p>
      <ul className={cn('space-y-0.5', mono && 'font-mono')}>
        {items.map((it, i) => (
          <li key={`${it}-${i}`} className="truncate">{it}</li>
        ))}
      </ul>
    </div>
  )
}
