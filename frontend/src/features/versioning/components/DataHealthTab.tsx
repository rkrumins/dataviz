/**
 * DataHealthTab — the manager-only "Data health" surface in the versioning slide-over.
 *
 * Business-plain throughout: the source of truth (Postgres) and the fast read layer (FalkorDB)
 * are never named by their technology outside the "Technical details" disclosure. Three calm
 * cards: (1) current freshness, (2) an on-demand sync check with a drift breakdown, and (3) a
 * confirmed rebuild of the fast read layer — all driven by the two projection mutations plus the
 * auto-polling watermark, with no store access.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Loader2, CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight, RefreshCw, RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import type { DriftReport } from '@/services/versioningApiService'
import { useProjectionWatermark, useReconcileProjection, useRebuildProjection } from '../hooks/useVersioning'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

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

export function DataHealthTab({ wsId, graphId }: { wsId: string; graphId: string }) {
  const { showToast } = useToast()
  const wmQ = useProjectionWatermark(wsId, graphId)
  const wm = wmQ.data
  const active = wm?.status === 'projecting' || wm?.status === 'rebuilding'

  const reconcile = useReconcileProjection(wsId, graphId)
  const rebuild = useRebuildProjection(wsId, graphId)

  const [deep, setDeep] = useState(false)
  const [report, setReport] = useState<DriftReport | null>(null)
  const [showTechnical, setShowTechnical] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)

  // Rebuild progress: 'running' once we've kicked one, 'done' once the watermark returns to fresh
  // AFTER we've observed it go behind — the ref guards against the pre-refetch fresh value flashing
  // "Up to date" before the rebuild registers.
  const [rebuildPhase, setRebuildPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const sawProgress = useRef(false)
  useEffect(() => {
    if (rebuildPhase !== 'running') return
    if (active || wm?.fresh === false) sawProgress.current = true
    else if (sawProgress.current && wm?.fresh) setRebuildPhase('done')
  }, [rebuildPhase, active, wm?.fresh])

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
          showToast(/already running/i.test(msg) ? 'info' : 'error',
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
          showToast('info', 'A rebuild is already in progress.')
          return
        }
        // The drift snapshot is now being repaired — drop it so we never show pre-rebuild drift.
        setReport(null)
        sawProgress.current = false
        setRebuildPhase('running')
      },
      onError: (e) => showToast('error', (e as Error).message),
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

  return (
    <div className="space-y-4">
      {/* 1 — Source-of-truth status */}
      <section className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">
        <h3 className="text-sm font-semibold text-ink font-display tracking-tight">Data freshness</h3>
        <p className="mt-2 text-[13px] text-ink-muted">
          Published version <span className="font-semibold text-ink">#{wm?.committed ?? '—'}</span>
          {' · '}
          Fast read layer at <span className="font-semibold text-ink">#{wm?.projected ?? '—'}</span>
        </p>
        <div className="mt-3">
          {!wm ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
            </span>
          ) : wm.fresh ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> Up to date
            </span>
          ) : wm.status === 'projecting' ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Refreshing…
            </span>
          ) : wm.status === 'rebuilding' ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Rebuilding…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" /> Out of date
            </span>
          )}
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
          disabled={rebuild.isPending}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/10 transition-colors disabled:opacity-60"
        >
          {rebuild.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          Rebuild fast read layer
        </button>

        {rebuildPhase === 'running' && (
          <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Rebuilding…
          </div>
        )}
        {rebuildPhase === 'done' && (
          <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> Up to date
          </div>
        )}
      </section>

      {confirmRebuild && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmRebuild(false)} />
          <div className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in">
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
