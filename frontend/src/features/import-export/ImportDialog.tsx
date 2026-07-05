/**
 * ImportDialog — bulk-import a spreadsheet/file into a data source's graph.
 *
 * Premium, guided, backend-driven: a large two-column dialog (a persistent "how it works" guide +
 * the action) that mirrors the ViewWizard's scale. Drop a file → choose how it reconciles → the
 * server imports it onto your working **draft** → review the added/updated/deleted changes in the
 * normal Changes UI and Publish/PR. It's the manual create/edit flow, at scale.
 */
import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Download, FileUp, Info, Loader2, Lock, Plus, Pencil,
  RefreshCw, ShieldAlert, Sparkles, Trash2, UploadCloud, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  createImport, detectFormat, getImport, pollJob, templateDownloadUrl, triggerBrowserDownload,
  type ImportFormat, type ImportSummary, type Job, type ReconcileMode,
} from '@/services/importExportApiService'

export interface ImportDialogProps {
  wsId: string
  graphId: string
  branchId?: string
  viewId?: string
  onClose: () => void
  onReviewChanges?: (branchId: string) => void
  onImported?: () => void
}

type Phase = 'choose' | 'running' | 'done' | 'failed'

const FORMATS: { id: ImportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' }, { id: 'tsv', label: 'TSV' },
  { id: 'ndjson', label: 'NDJSON' }, { id: 'json', label: 'JSON' },
]

const UNSUPPORTED: Record<string, string> = {
  xlsx: 'Excel workbook', xlsm: 'Excel workbook', xls: 'Excel workbook',
  numbers: 'Numbers file', parquet: 'Parquet file', zip: 'Zip archive',
}

function unsupportedReason(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() || ''
  return UNSUPPORTED[ext] ? `${UNSUPPORTED[ext]}s aren't supported yet` : null
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ImportDialog({ wsId, graphId, branchId, viewId, onClose, onReviewChanges, onImported }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [autoDetected, setAutoDetected] = useState(false)
  const [reconcileMode, setReconcileMode] = useState<ReconcileMode>('upsert')
  const [phase, setPhase] = useState<Phase>('choose')
  const [job, setJob] = useState<Job | null>(null)
  const [resultBranch, setResultBranch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((f: File | null) => {
    setFile(f)
    setAutoDetected(false)
    if (f) detectFormat(f).then((fmt) => { setFormat(fmt); setAutoDetected(true) }).catch(() => {})
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }, [handleFile])

  const warning = file ? unsupportedReason(file.name) : null

  async function start() {
    if (!file) return
    setPhase('running')
    setError(null)
    try {
      const created = await createImport(wsId, graphId, file, { format, reconcileMode, branchId, viewId })
      setResultBranch(created.branchId)
      const done = await pollJob(() => getImport(wsId, graphId, created.jobId), { onTick: setJob })
      if (done.status === 'failed') {
        setError(done.errorMessage || 'The import could not be completed.')
        setPhase('failed')
      } else {
        setJob(done)
        setPhase('done')
        onImported?.()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import could not be completed.')
      setPhase('failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={phase === 'running' ? undefined : onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header */}
        <div className="border-b border-glass-border/50 px-8 py-5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-ink">Import data</h3>
              <p className="text-xs text-ink-muted mt-0.5">
                Bulk-create and update entities from a file — reviewed before anything is published
              </p>
            </div>
          </div>
          {phase !== 'running' && (
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {phase === 'choose' && (
            <ChooseStep
              file={file} setFile={handleFile} dragging={dragging} setDragging={setDragging} onDrop={onDrop}
              inputRef={inputRef} reconcileMode={reconcileMode} setReconcileMode={setReconcileMode}
              format={format} setFormat={(f) => { setFormat(f); setAutoDetected(false) }} autoDetected={autoDetected}
              warning={warning}
              onDownloadTemplate={() => triggerBrowserDownload(templateDownloadUrl(wsId, graphId, 'csv'), 'import-template.csv')}
            />
          )}
          {phase === 'running' && <RunningStep job={job} fileName={file?.name} />}
          {phase === 'done' && <DoneStep summary={(job?.summary as ImportSummary) ?? null} />}
          {phase === 'failed' && <FailedStep error={error} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-8 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
          {phase === 'done' ? (
            <button onClick={() => { setFile(null); setJob(null); setPhase('choose') }} className="px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              Import another
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={phase === 'running'} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
              {phase === 'done' ? 'Close' : 'Cancel'}
            </button>
            {phase === 'choose' && (
              <button onClick={start} disabled={!file || !!warning}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-indigo-500/20">
                <UploadCloud className="w-4 h-4" /> Import
              </button>
            )}
            {phase === 'done' && (
              <button onClick={() => resultBranch && onReviewChanges?.(resultBranch)}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20">
                Review changes <ArrowRight className="w-4 h-4" />
              </button>
            )}
            {phase === 'failed' && (
              <button onClick={() => setPhase('choose')}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                <RefreshCw className="w-4 h-4" /> Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── choose (two columns: guide | action) ─────────────────────────────────────
function ChooseStep(props: {
  file: File | null
  setFile: (f: File | null) => void
  dragging: boolean
  setDragging: (d: boolean) => void
  onDrop: (e: React.DragEvent) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  reconcileMode: ReconcileMode
  setReconcileMode: (m: ReconcileMode) => void
  format: ImportFormat
  setFormat: (f: ImportFormat) => void
  autoDetected: boolean
  warning: string | null
  onDownloadTemplate: () => void
}) {
  const {
    file, setFile, dragging, setDragging, onDrop, inputRef, reconcileMode, setReconcileMode,
    format, setFormat, autoDetected, warning,
  } = props
  return (
    <div className="grid md:grid-cols-2">
      {/* Left — the guide (persistent context) */}
      <div className="px-8 py-6 border-b md:border-b-0 md:border-r border-glass-border/50 bg-gradient-to-br from-indigo-50/40 to-transparent dark:from-indigo-950/15 space-y-5">
        <div>
          <h4 className="text-sm font-bold text-ink">How importing works</h4>
          <p className="text-[11px] text-ink-muted mt-0.5">Offline edits, applied safely — with a full review first.</p>
        </div>
        <ol className="space-y-3">
          <Step n={1} title="Download a starter template" body="Prefilled with your current data so you learn the columns instantly." />
          <Step n={2} title="Edit it anywhere" body="Excel, Google Sheets, or any editor. Add rows to create, edit cells to update." />
          <Step n={3} title="Upload it here" body="Any CSV, TSV, NDJSON or JSON — the format is detected automatically." />
          <Step n={4} title="Review every change" body="See exactly what's new, updated or deleted on a draft before it's live." />
          <Step n={5} title="Publish or open a PR" body="Nothing touches the published model until you approve it." />
        </ol>
        <button
          onClick={props.onDownloadTemplate}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-indigo-200/80 dark:border-indigo-800/50 bg-white/70 dark:bg-white/[0.04] text-indigo-600 dark:text-indigo-400 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
        >
          <Download className="w-4 h-4" /> Download a starter template
        </button>
        <div className="flex items-start gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
          <Lock className="w-3.5 h-3.5 text-ink-muted mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-ink-muted leading-relaxed">
            The greyed <span className="font-medium text-ink-secondary">entity_id</span> / <span className="font-medium text-ink-secondary">urn</span> columns are the identity — leave them as-is so edits match the right item. Set <span className="font-mono text-ink-secondary">_op=delete</span> on a row to remove it.
          </p>
        </div>
      </div>

      {/* Right — the action */}
      <div className="px-8 py-6 space-y-5">
        <input ref={inputRef} type="file" className="hidden"
          onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />

        {!file ? (
          <button
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'w-full rounded-2xl border-2 border-dashed px-6 py-12 flex flex-col items-center gap-3 transition-all duration-200',
              dragging
                ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30 scale-[1.01]'
                : 'border-glass-border hover:border-glass-border-hover bg-black/[0.015] dark:bg-white/[0.015]',
            )}
          >
            <div className={cn('w-14 h-14 rounded-2xl flex items-center justify-center transition-colors',
              dragging ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5')}>
              <FileUp className={cn('w-7 h-7', dragging ? 'text-indigo-500' : 'text-ink-muted')} />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-ink">{dragging ? 'Drop to upload' : 'Drop a file, or click to browse'}</p>
              <p className="text-[11px] text-ink-muted mt-1">CSV, TSV, NDJSON or JSON · up to millions of rows</p>
            </div>
          </button>
        ) : (
          <div className="space-y-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
            <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center flex-shrink-0">
                <FileUp className="w-5 h-5 text-indigo-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{file.name}</p>
                <p className="text-[11px] text-ink-muted mt-0.5">{prettyBytes(file.size)}</p>
              </div>
              <button onClick={() => setFile(null)} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {warning ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  {warning}. Please open it and 'Save As' CSV, then import that file.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-ink-secondary">File format</label>
                  {autoDetected && <span className="text-[10px] text-ink-muted flex items-center gap-1"><Info className="w-3 h-3" /> Auto-detected · change if needed</span>}
                </div>
                <div className="flex items-center gap-1 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-1">
                  {FORMATS.map((f) => (
                    <button key={f.id} onClick={() => setFormat(f.id)}
                      className={cn('flex-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors',
                        format === f.id ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink')}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-2">How should it reconcile?</label>
          <div className="space-y-2">
            <ModeCard active={reconcileMode === 'upsert'} onClick={() => setReconcileMode('upsert')}
              icon={<Sparkles className="w-4 h-4" />} title="Add & update" tone="indigo"
              desc="Creates new items and updates matching ones. Never deletes — safe default." />
            <ModeCard active={reconcileMode === 'replace'} onClick={() => setReconcileMode('replace')}
              icon={<ShieldAlert className="w-4 h-4" />} title="Replace (authoritative)" tone="amber"
              desc="The file becomes the source of truth — items missing from it are deleted." />
          </div>
          {reconcileMode === 'replace' && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 animate-in fade-in duration-150">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                You'll see exactly what would be deleted in the review before anything is published.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{n}</span>
      <div>
        <p className="text-xs font-semibold text-ink">{title}</p>
        <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{body}</p>
      </div>
    </li>
  )
}

function ModeCard(props: {
  active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string; tone: 'indigo' | 'amber'
}) {
  const activeRing = props.tone === 'indigo'
    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
    : 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20 shadow-sm shadow-amber-500/10'
  const activeChip = props.tone === 'indigo'
    ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500'
    : 'bg-amber-100 dark:bg-amber-900/50 text-amber-500'
  return (
    <button onClick={props.onClick}
      className={cn('w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
        props.active ? activeRing : 'border-glass-border hover:border-glass-border-hover')}>
      <div className="flex items-center gap-3">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          props.active ? activeChip : 'bg-black/5 dark:bg-white/5 text-ink-muted')}>
          {props.icon}
        </div>
        <div className="flex-1">
          <span className="text-sm font-semibold text-ink">{props.title}</span>
          <p className="text-[11px] text-ink-muted mt-0.5">{props.desc}</p>
        </div>
      </div>
    </button>
  )
}

// ── running ──────────────────────────────────────────────────────────────────
function RunningStep({ job, fileName }: { job: Job | null; fileName?: string }) {
  const phaseLabel = !job || job.status === 'pending' ? 'Uploading…' : 'Reconciling changes…'
  return (
    <div className="px-8 py-16 flex flex-col items-center gap-5">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
        <div className="relative w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
          <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-ink">{phaseLabel}</p>
        <p className="text-[11px] text-ink-muted mt-1 truncate max-w-[24rem]">{fileName}</p>
      </div>
      <div className="w-full max-w-sm h-1 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
        <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600 animate-pulse" />
      </div>
      <p className="text-[11px] text-ink-muted">You can keep working — this runs in the background.</p>
    </div>
  )
}

// ── done ─────────────────────────────────────────────────────────────────────
function DoneStep({ summary }: { summary: ImportSummary | null }) {
  const s = summary
  const nothing = s && s.new === 0 && s.updated === 0 && s.deleted === 0
  return (
    <div className="px-8 py-8 max-w-2xl mx-auto">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-ink">Ready to review</h3>
          <p className="text-sm text-ink-muted mt-1">
            {nothing
              ? 'No changes — your data already matches the file.'
              : 'Your changes are staged on a draft and are now visible in the canvas and the Changes tab. Review them, then publish or open a pull request.'}
          </p>
        </div>
      </div>
      {s && (
        <div className="mt-6 grid grid-cols-4 gap-3">
          <Stat n={s.new} label="New" icon={<Plus className="w-4 h-4" />} tone="emerald" />
          <Stat n={s.updated} label="Updated" icon={<Pencil className="w-4 h-4" />} tone="blue" />
          <Stat n={s.deleted} label="Deleted" icon={<Trash2 className="w-4 h-4" />} tone="rose" />
          <Stat n={s.invalid} label="Skipped" icon={<AlertTriangle className="w-4 h-4" />} tone="amber" />
        </div>
      )}
      {s && s.invalid > 0 && (
        <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
          {s.invalid} row{s.invalid === 1 ? '' : 's'} were skipped (invalid) and left out of the draft.
        </p>
      )}
    </div>
  )
}

function Stat({ n, label, icon, tone }: { n: number; label: string; icon: React.ReactNode; tone: 'emerald' | 'blue' | 'rose' | 'amber' }) {
  const tones: Record<string, string> = {
    emerald: 'text-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20',
    blue: 'text-blue-500 bg-blue-50/60 dark:bg-blue-950/20',
    rose: 'text-rose-500 bg-rose-50/60 dark:bg-rose-950/20',
    amber: 'text-amber-500 bg-amber-50/60 dark:bg-amber-950/20',
  }
  const muted = n === 0
  return (
    <div className={cn('rounded-xl border border-glass-border p-4 flex flex-col gap-1.5', muted ? 'opacity-50' : tones[tone])}>
      <span className={muted ? 'text-ink-muted' : ''}>{icon}</span>
      <span className={cn('text-2xl font-bold tabular-nums', muted ? 'text-ink-muted' : 'text-ink')}>{n}</span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
    </div>
  )
}

// ── failed ───────────────────────────────────────────────────────────────────
function FailedStep({ error }: { error: string | null }) {
  return (
    <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-500 flex items-center justify-center flex-shrink-0">
        <AlertTriangle className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg font-bold text-ink">Import didn't complete</h3>
        <p className="text-sm text-ink-muted mt-1 break-words">{error}</p>
      </div>
    </div>
  )
}
