/**
 * How an export the server prepares is getting on — one component, wherever it is shown.
 *
 * `ExportProgressPanel` is the full view an export dialog shows while the file is prepared: a ring
 * with the percent done (or a turning arc while that can't be told), the step it is on of all it
 * goes through, what it has written so far, how long it has taken and roughly how long is left,
 * and, up front, that the download starts by itself. `ExportStatusRow` is the same, compact, for
 * the export tray the person sees while they work on (on the canvas, or anywhere else), and it
 * says how an export ended too. Both read the export as followed app-wide (`backgroundExports`),
 * so the dialog and the tray never disagree.
 */
import { useEffect, useId, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle, Ban, Check, CheckCircle2, Clock, FileDown, Info, Loader2, Package, RefreshCw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { queuePosition, resumeNote, type ExportSummary } from '@/services/importExportApiService'
import { CancelExport } from './CancelExport'
import {
  dismissExport, downloadExportFile, exportBytes, exportProgress, exportStage, exportSteps, isWorking, retryExport,
  type BackgroundExport, type ExportStage,
} from './backgroundExports'
import { formatElapsed, prettyBytes, timeLeft } from './format'

/** The time now, every second while ``ticking``. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** A ring round the export's icon: the percent done, or a turning arc while that isn't known. The
 *  large one says the percent in its middle. */
export function ExportStatusIcon({ e, size = 'sm' }: { e: BackgroundExport; size?: 'sm' | 'lg' }) {
  const stage = exportStage(e)
  const { pct } = exportProgress(e)
  const Icon = stage === 'failed' || stage === 'lost' || stage === 'expired' ? AlertTriangle
    : stage === 'cancelled' ? Ban
      : stage === 'downloaded' || stage === 'ready' ? CheckCircle2
        : e.kind === 'package' ? Package : FileDown
  const large = size === 'lg'
  return (
    <span className={cn('relative flex-shrink-0', large ? 'w-24 h-24' : 'w-9 h-9')}>
      {large && isWorking(stage) && <span className="absolute inset-2 rounded-full bg-indigo-500/10 blur-xl" aria-hidden />}
      <span className={cn('absolute rounded-full flex flex-col items-center justify-center',
        large ? 'inset-[9px]' : 'inset-[3px]',
        isWorking(stage) && (large
          ? 'bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-950/60 dark:to-violet-950/60 text-indigo-600 dark:text-indigo-300'
          : 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/30'),
        (stage === 'ready' || stage === 'downloaded') && 'bg-emerald-500/10 text-emerald-500',
        (stage === 'failed' || stage === 'expired') && 'bg-rose-500/10 text-rose-500',
        stage === 'lost' && 'bg-amber-500/10 text-amber-500',
        stage === 'cancelled' && 'bg-black/5 dark:bg-white/10 text-ink-muted')}>
        {large && isWorking(stage) && pct != null
          ? <span className="text-xl font-bold tabular-nums text-ink">{pct}<span className="text-xs font-semibold text-ink-muted">%</span></span>
          : <Icon className={large ? 'w-7 h-7' : 'w-4 h-4'} />}
      </span>
      {isWorking(stage) && <ProgressRing pct={pct} thin={large} />}
    </span>
  )
}

/** A ring filling to ``pct``, or a turning arc while that isn't known: laid over its container. */
export function ProgressRing({ pct, thin = false }: { pct: number | null; thin?: boolean }) {
  const gradient = `export-ring-${useId().replace(/[^\w-]/g, '')}`
  const r = 16.5
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 36 36" aria-hidden className={cn('absolute inset-0 w-full h-full -rotate-90', pct == null && 'animate-spin')}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <circle cx="18" cy="18" r={r} fill="none" strokeWidth={thin ? 1.6 : 2} className="stroke-indigo-500/15" />
      <circle cx="18" cy="18" r={r} fill="none" strokeWidth={thin ? 1.6 : 2} strokeLinecap="round" stroke={`url(#${gradient})`}
        className="transition-[stroke-dashoffset] duration-700 ease-out"
        strokeDasharray={c} strokeDashoffset={pct == null ? c * 0.72 : c * (1 - pct / 100)} />
    </svg>
  )
}

export function ExportProgressBar({ pct, className }: { pct: number | null; className?: string }) {
  return (
    <div className={cn('h-1.5 rounded-full overflow-hidden',
      pct != null ? 'bg-black/5 dark:bg-white/10' : 'bg-indigo-500/10 dark:bg-indigo-400/15', className)}>
      {pct != null
        ? <div role="progressbar" aria-label="Export progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
            className="relative h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500 bg-[length:200%_100%] transition-[width] duration-700 ease-out"
            style={{ width: `${Math.max(pct, 2)}%` }} />
        : <motion.div className="h-full w-2/5 rounded-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent"
            animate={{ x: ['-100%', '250%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />}
    </div>
  )
}

/** The steps an export goes through, the done ones ticked and the one it is on marked. */
function ExportSteps({ e }: { e: BackgroundExport }) {
  const { steps, current } = exportSteps(e)
  return (
    <ol className="flex items-start" aria-label="Export steps">
      {steps.map((step, i) => {
        const done = i < current
        const on = i === current
        return (
          <li key={step} aria-current={on ? 'step' : undefined} className="relative flex-1 flex flex-col items-center gap-1.5 text-center">
            {i > 0 && (
              <span aria-hidden className={cn('absolute top-2.5 right-1/2 w-full h-0.5 -translate-y-1/2 rounded-full',
                i <= current ? 'bg-gradient-to-r from-indigo-500 to-violet-500' : 'bg-black/10 dark:bg-white/10')} />
            )}
            <span className={cn('relative z-10 w-5 h-5 rounded-full flex items-center justify-center ring-4 ring-canvas-elevated transition-colors',
              done && 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white',
              on && 'bg-canvas-elevated border-2 border-indigo-500',
              !done && !on && 'bg-canvas-elevated border-2 border-black/10 dark:border-white/15')}>
              {done ? <Check className="w-3 h-3" strokeWidth={3} />
                : on ? <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" /> : null}
            </span>
            <span className={cn('text-[10px] leading-tight px-1', on ? 'font-semibold text-ink' : done ? 'text-ink-secondary' : 'text-ink-muted')}>
              {step}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-black/[0.025] dark:bg-white/[0.04] border border-glass-border px-3 py-2.5">
      <p className="text-sm font-bold text-ink tabular-nums truncate">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-ink-muted mt-0.5">{label}</p>
    </div>
  )
}

/** "Your download starts automatically": said before it does, wherever the export is shown. */
export function AutoDownloadNote({ compact = false }: { compact?: boolean }) {
  return compact ? (
    <p className="text-[11px] text-ink-muted leading-relaxed">
      Your download starts automatically when the file is ready. Keep working, or leave this page: the
      export carries on.
    </p>
  ) : (
    <div className="flex items-start gap-2.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50 px-3.5 py-2.5">
      <Info className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
      <p className="text-[11px] text-ink-muted leading-relaxed">
        <span className="font-semibold text-ink-secondary">Your download starts automatically</span> as soon as the
        file is ready. You can close this and keep working: the export carries on, and you can follow it from
        Exports, bottom right.
      </p>
    </div>
  )
}

// ── In a dialog ──────────────────────────────────────────────────────────────

/** An export being prepared, in full: for the dialog that started it, while it runs. */
export function ExportProgressPanel({ e }: { e: BackgroundExport }) {
  const stage = exportStage(e)
  const { label, pct } = exportProgress(e)
  const { steps, current } = exportSteps(e)
  const now = useNow(isWorking(stage))
  const elapsed = now - e.startedAt
  const left = timeLeft(elapsed, pct)
  const queued = queuePosition(e.job)
  const resumed = resumeNote(e.job)
  const sofar = e.job?.status === 'running' ? (e.job.summary as ExportSummary | null) : null
  return (
    <div className="max-w-xl mx-auto w-full space-y-6">
      <div className="flex items-center gap-5">
        <ExportStatusIcon e={e} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-500">
            {queued ? 'Waiting its turn'
              : `Step ${Math.min(current, steps.length - 1) + 1} of ${steps.length} · ${steps[Math.min(current, steps.length - 1)]}`}
          </p>
          <h4 className="text-lg font-bold text-ink mt-0.5 truncate" title={e.fileName}>{e.fileName}</h4>
          <p className="text-xs text-ink-muted mt-0.5 truncate" title={e.label}>{e.label}</p>
        </div>
      </div>

      <ExportSteps e={e} />

      <div>
        <ExportProgressBar pct={pct} />
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <p className="text-xs text-ink-secondary">{label}</p>
          {pct != null && (
            <span className="text-xs text-ink-muted tabular-nums whitespace-nowrap">
              {left && <>{left} · </>}<span className="font-semibold text-ink">{pct}%</span>
            </span>
          )}
        </div>
        {queued && <p className="text-[11px] text-ink-muted mt-1">{queued}</p>}
        {resumed && <p className="text-[11px] text-ink-muted mt-1">{resumed}</p>}
      </div>

      {sofar && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat value={sofar.nodes.toLocaleString()} label="Entities" />
          <Stat value={sofar.edges.toLocaleString()} label="Relationships" />
          <Stat value={prettyBytes(sofar.bytes ?? 0)} label="Written" />
          <Stat value={formatElapsed(elapsed)} label="Elapsed" />
        </div>
      )}

      <AutoDownloadNote />
    </div>
  )
}

// ── In the tray ──────────────────────────────────────────────────────────────

/** An export in the tray: how it is getting on, or how it ended, with what can be done about it. */
export function ExportStatusRow({ e }: { e: BackgroundExport }) {
  const stage = exportStage(e)
  const { label, pct } = exportProgress(e)
  const live = isWorking(stage)
  const now = useNow(live)
  const elapsed = now - e.startedAt
  const left = timeLeft(elapsed, pct)
  const note = queuePosition(e.job) ?? resumeNote(e.job)
  return (
    <div className="flex items-start gap-3">
      <ExportStatusIcon e={e} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-ink truncate flex-1" title={e.fileName}>{e.fileName}</p>
          {live && pct != null && <span className="text-[11px] font-semibold text-ink tabular-nums">{pct}%</span>}
          {!live && (
            <button type="button" onClick={() => dismissExport(e.jobId)} aria-label={`Dismiss ${e.fileName}`}
              className="p-0.5 -mr-1 rounded-md text-ink-muted opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-opacity">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-[11px] text-ink-muted truncate" title={e.label}>{e.label}</p>
        {live ? (
          <>
            <p className="mt-1 text-[11px] leading-snug text-ink-secondary">{label}</p>
            <ExportProgressBar pct={pct} className="mt-2 h-1" />
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="flex items-center gap-1 text-[10px] text-ink-muted tabular-nums">
                <Clock className="w-3 h-3" /> {formatElapsed(elapsed)}{left ? ` · ${left}` : note ? ` · ${note}` : ''}
              </span>
              <CancelExport jobId={e.jobId} variant="row" />
            </div>
          </>
        ) : <Ended e={e} stage={stage} />}
      </div>
    </div>
  )
}

function Ended({ e, stage }: { e: BackgroundExport; stage: ExportStage }) {
  const line = 'mt-1 text-[11px] leading-snug'
  const link = 'font-semibold text-indigo-600 dark:text-indigo-400 hover:underline'
  const bytes = exportBytes(e)
  switch (stage) {
    case 'ready':
      return e.cancelRequested ? (
        <p className={cn(line, 'text-ink-secondary')}>
          It finished before it could be stopped.{' '}
          <button type="button" onClick={() => downloadExportFile(e.jobId)} className={link}>Download it</button>
        </p>
      ) : (
        <p className={cn(line, 'flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400')}>
          <Loader2 className="w-3 h-3 animate-spin" /> Ready: your download is starting…
        </p>
      )
    case 'downloaded':
      return (
        <p className={cn(line, 'flex flex-wrap items-center gap-x-1.5 text-emerald-600 dark:text-emerald-400')}>
          Downloaded{bytes != null ? ` · ${prettyBytes(bytes)}` : ''}
          <button type="button" onClick={() => downloadExportFile(e.jobId)} className={cn(link, 'ml-1')}>Download again</button>
        </p>
      )
    case 'expired':
      return <p className={cn(line, 'text-ink-muted')}>The file is no longer kept. Export it again.</p>
    case 'failed':
      return <p className={cn(line, 'text-rose-600 dark:text-rose-400 break-words')}>{e.job?.errorMessage || "The export didn't finish."}</p>
    case 'cancelled':
      return <p className={cn(line, 'text-ink-muted')}>Cancelled. Nothing was downloaded.</p>
    case 'lost':
      return (
        <p className={cn(line, 'text-amber-600 dark:text-amber-400')}>
          Lost touch with the export; it may still be under way.{' '}
          <button type="button" onClick={() => retryExport(e.jobId)} className={cn(link, 'inline-flex items-center gap-1')}>
            <RefreshCw className="w-3 h-3" /> Check again
          </button>
        </p>
      )
    default:
      return null
  }
}
