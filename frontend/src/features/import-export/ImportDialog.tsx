/**
 * ImportDialog — bulk-import a spreadsheet/file into a data source's graph.
 *
 * Premium, guided, backend-driven: a large two-column dialog (a persistent "how it works" guide +
 * the action) that mirrors the ViewWizard's scale. Drop a file → choose how it reconciles → the
 * server imports it onto your working **draft** → review the added/updated/deleted changes in the
 * normal Changes UI and Publish/PR. It's the manual create/edit flow, at scale.
 *
 * Two front doors, one import: the standard file goes up as it is, and the simple files — a things
 * CSV and a connections CSV (both at once), or one JSON file — are read here and go up as the
 * standard's rows (`fileRows`), their types matched to the graph's by id, then by name. What was
 * recognised is said before anything is sent, with the types the graph's data model lacks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Download, FileUp, Info, Loader2, Lock, Plus, Pencil,
  RefreshCw, Sparkles, Trash2, UploadCloud, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import {
  getImportSettings, jobProgressText, queuePosition, resumeNote, templateDownloadUrl, triggerBrowserDownload,
  type ImportFormat, type ImportPreviewRow, type ImportSettings, type ImportSummary, type Job, type ReconcileMode,
} from '@/services/importExportApiService'
import { prettyBytes } from './format'
import { RefusedRowsPanel } from './RefusedRowsPanel'
import { formatIdentifier, identifierLabel, parseIdentifier, type Match } from './identifier'
import { matchTypes, whereOf, type FileRead, type TypeMap, type TypeRef } from './fileRows'
import { downloadSimpleTemplate, useFileIntake, type FileIntake } from './useFileIntake'
import { blocked, byUrnFix, heldForRows, refusedOf, useImportRun } from './useImportRun'
import { ImportOptions, matchNote } from './ImportOptions'

/** The graph's types, which the simple files' types are matched to. */
export interface GraphTypes {
  entity: TypeRef[]
  relationship: TypeRef[]
}

export interface ImportDialogProps {
  wsId: string
  graphId: string
  branchId?: string
  viewId?: string
  /** The graph's data model: the simple files' types are matched to it, and the ones it lacks named. */
  types?: GraphTypes
  onClose: () => void
  onReviewChanges?: (branchId: string) => void
  /** The import committed to the draft — with what it did. */
  onImported?: (summary: ImportSummary | null) => void
}

const FORMATS: { id: ImportFormat; label: string }[] = [
  { id: 'xlsx', label: 'Excel' }, { id: 'csv', label: 'CSV' }, { id: 'tsv', label: 'TSV' },
  { id: 'ndjson', label: 'NDJSON' }, { id: 'json', label: 'JSON' },
]

/** The simple files' types as the graph's: the ones it has by id or name; any other as written
 *  (the server refuses its rows, saying why). */
function typeMapOf(read: FileRead | null, types?: GraphTypes): TypeMap {
  if (!read || !types) return { entity: {}, relationship: {} }
  return {
    entity: matchTypes(read.summary.thingTypes.map(([t]) => t), types.entity),
    relationship: matchTypes(read.summary.connectionTypes.map(([t]) => t), types.relationship),
  }
}

export function ImportDialog({ wsId, graphId, branchId, viewId, types, onClose, onReviewChanges, onImported }: ImportDialogProps) {
  const intake = useFileIntake()
  const run = useImportRun()
  const [reconcileMode, setReconcileMode] = useState<ReconcileMode>('upsert')
  // What its rows find their items by: null takes the graph's default, which the server applies.
  const [match, setMatch] = useState<Match | null>(null)
  // A replace by a property: delete only the items that hold it (replaceScope=keyed).
  const [keyedOnly, setKeyedOnly] = useState(false)
  const [settings, setSettings] = useState<ImportSettings | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    getImportSettings(wsId, graphId).then((got) => { if (live) setSettings(got) }).catch(() => {})
    return () => { live = false }
  }, [wsId, graphId])

  const phase = run.phase === 'idle' ? 'choose' : run.phase
  const typeMap = useMemo(() => typeMapOf(intake.read, types), [intake.read, types])
  const note = matchNote(match, settings)
  const job = run.job

  /** ``past``: a replace that was held, sent again into its draft — past the replace guard, or
   *  (``refused``) without the rows it refused, or (``identifier``) matching by another key. */
  async function start(past?: { branchId: string; refused?: boolean; identifier?: string }) {
    const up = intake.upload(typeMap)
    if (!up) return
    const done = await run.start({ wsId, graphId }, up.file, {
      format: up.format, reconcileMode, branchId: past?.branchId ?? branchId, viewId,
      identifier: past?.identifier ?? (match ? formatIdentifier(match) : undefined),
      allowMassDelete: !!past && !past.refused && !past.identifier,
      maxRefusedRows: past?.refused ? '-1' : undefined,
      replaceScope: reconcileMode === 'replace' && keyedOnly ? 'keyed' : undefined,
    })
    if (done && done.status !== 'failed' && done.status !== 'cancelled') {
      onImported?.((done.summary as ImportSummary | undefined) ?? null)
    }
  }

  const ready = !!intake.read && !intake.reading && !intake.warning && !note?.block

  return (
    <>
    <Backdrop open={true} onClick={phase === 'running' ? undefined : onClose} zClassName="z-50" className="bg-black/50 backdrop-blur-sm" />
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden pointer-events-auto">
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
              intake={intake} inputRef={inputRef} types={types}
              options={
                <ImportOptions
                  reconcile={{ mode: reconcileMode, onChange: setReconcileMode, viewScoped: !!viewId }}
                  match={match} onMatch={setMatch} graphDefault={settings?.effective.identifier ?? null} note={note}
                  keyedOnly={{ value: keyedOnly, onChange: setKeyedOnly }}
                />
              }
              onDownloadTemplate={(fmt) => triggerBrowserDownload(templateDownloadUrl(wsId, graphId, fmt), `import-template.${fmt}`)}
            />
          )}
          {phase === 'running' && <RunningStep job={job} upload={run.upload} fileName={intake.files.map((f) => f.name).join(', ')} />}
          {phase === 'done' && <DoneStep summary={(job?.summary as ImportSummary) ?? null} previewRows={run.previewRows}
            identifier={job?.identifier ?? null} wsId={wsId} graphId={graphId} jobId={job?.jobId ?? null} />}
          {phase === 'failed' && <FailedStep error={run.error} job={job} wsId={wsId} graphId={graphId} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-8 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
          {phase === 'done' ? (
            <button onClick={() => { intake.clear(); run.reset() }} className="px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              Import another
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={phase === 'running'} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
              {phase === 'done' ? 'Close' : 'Cancel'}
            </button>
            {phase === 'choose' && (
              <button onClick={() => void start()} disabled={!ready}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-indigo-500/20">
                <UploadCloud className="w-4 h-4" /> Import
              </button>
            )}
            {phase === 'done' && (
              <button onClick={() => run.resultBranch && onReviewChanges?.(run.resultBranch)}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20">
                Review changes <ArrowRight className="w-4 h-4" />
              </button>
            )}
            {phase === 'failed' && blocked(job) && job?.branchId && (
              <button onClick={() => void start({ branchId: job.branchId! })}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-rose-300 dark:border-rose-800/60 text-rose-600 dark:text-rose-400 text-sm font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                <Trash2 className="w-4 h-4" /> Replace anyway
              </button>
            )}
            {phase === 'failed' && byUrnFix(job) && job?.branchId && (
              <button onClick={() => {
                const fix = byUrnFix(job)!
                setMatch(parseIdentifier(fix))
                void start({ branchId: job.branchId!, identifier: fix })
              }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                <Sparkles className="w-4 h-4" /> Find them by their urn
              </button>
            )}
            {phase === 'failed' && heldForRows(job) && job?.branchId && (
              <button onClick={() => void start({ branchId: job.branchId!, refused: true })}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-rose-300 dark:border-rose-800/60 text-rose-600 dark:text-rose-400 text-sm font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                <Trash2 className="w-4 h-4" /> Import the rest anyway
              </button>
            )}
            {phase === 'failed' && (
              <button onClick={run.reset}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                <RefreshCw className="w-4 h-4" /> Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    </>
  )
}

/** The simple files' types the graph's data model has none of: their rows would be refused. */
function missingTypes(read: FileRead, types: GraphTypes | undefined) {
  if (!types) return { entity: [] as string[], relationship: [] as string[] }
  const known = typeMapOf(read, types)
  return {
    entity: read.summary.thingTypes.map(([t]) => t).filter((t) => !known.entity[t]),
    relationship: read.summary.connectionTypes.map(([t]) => t).filter((t) => !known.relationship[t]),
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What was recognised in the files, before anything is sent: their rows, the types the graph
 *  lacks, and rows that would be refused. */
function FileNote({ read, files, types }: { read: FileRead; files: File[]; types?: GraphTypes }) {
  if (read.format === 'server') return null
  const holds = [read.things.length > 0 && 'things', read.connections.length > 0 && 'connections'].filter(Boolean).join(' and ')
  const what = read.format === 'standard' ? 'Standard import file'
    : `${holds ? holds[0].toUpperCase() + holds.slice(1) : 'Simple'} file${files.length > 1 ? 's' : ''}`
  const missing = missingTypes(read, types)
  const lacks = [
    ...missing.entity.map((t) => `${t} (things)`),
    ...missing.relationship.map((t) => `${t} (connections)`),
  ]
  return (
    <div role="note" aria-label="What the import reads" className="space-y-1.5 rounded-lg border border-indigo-200/70 dark:border-indigo-800/40 bg-indigo-50/60 dark:bg-indigo-950/20 px-3 py-2">
      <p className="text-[11px] text-ink">
        <span className="font-semibold">{what}:</span> {count(read.things.length, 'thing')}, {count(read.connections.length, 'connection')}
      </p>
      {lacks.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          This graph’s data model has no {lacks.join(', ')} type: those rows will be refused. Add the
          type{lacks.length === 1 ? '' : 's'} to its semantic layer first, or change the file.
        </p>
      )}
      {read.errors.length > 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400">
          <p>{count(read.errors.length, 'row')} may be refused:</p>
          <ul className="mt-0.5 space-y-0.5">
            {read.errors.slice(0, 3).map((e) => (
              <li key={`${e.section}:${e.index}:${e.field}`}>{whereOf(e)} · {e.field}: {e.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── choose (two columns: guide | action) ─────────────────────────────────────
function ChooseStep({ intake, inputRef, types, options, onDownloadTemplate }: {
  intake: FileIntake
  inputRef: React.RefObject<HTMLInputElement | null>
  types?: GraphTypes
  /** How it reconciles and what it matches by. */
  options: React.ReactNode
  onDownloadTemplate: (format: ImportFormat) => void
}) {
  const { files, read, reading, errors, warning, dragging, setDragging, format, setFormat, autoDetected } = intake
  return (
    <div className="grid md:grid-cols-2">
      {/* Left — the guide (persistent context) */}
      <div className="px-8 py-6 border-b md:border-b-0 md:border-r border-glass-border/50 bg-gradient-to-br from-indigo-50/40 to-transparent dark:from-indigo-950/15 space-y-5">
        <div>
          <h4 className="text-sm font-bold text-ink">How importing works</h4>
          <p className="text-[11px] text-ink-muted mt-0.5">Offline edits, applied safely — with a full review first.</p>
        </div>
        <ol className="space-y-3">
          <Step n={1} title="Download a starter template" body="Every column your data can carry, with an example row of each type. To change what's there, export it instead." />
          <Step n={2} title="Edit it anywhere" body="Excel, Sheets, or any editor. Each property is its own column — edit a cell to change it, add a prop.<name> column for a new one." />
          <Step n={3} title="Upload it here" body="Excel, CSV, TSV, NDJSON or JSON — the format is detected automatically. Or a things CSV and a connections CSV, together." />
          <Step n={4} title="Review every change" body="See exactly what's new, updated or deleted on a draft before it's live." />
          <Step n={5} title="Publish or open a PR" body="Nothing touches the published model until you approve it." />
        </ol>
        <div className="space-y-1.5">
          <button
            onClick={() => onDownloadTemplate('xlsx')}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-indigo-200/80 dark:border-indigo-800/50 bg-white/70 dark:bg-white/[0.04] text-indigo-600 dark:text-indigo-400 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
          >
            <Download className="w-4 h-4" /> Download a starter template
          </button>
          <p className="text-center text-[11px] text-ink-muted">
            Excel, with a sheet explaining every column · or{' '}
            {(['csv', 'ndjson'] as const).map((fmt, i) => (
              <span key={fmt}>
                {i > 0 && ' · '}
                <button onClick={() => onDownloadTemplate(fmt)}
                  className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                  {fmt === 'csv' ? 'CSV' : 'NDJSON'}
                </button>
              </span>
            ))}
          </p>
          <p className="text-center text-[11px] text-ink-muted">
            Or the simple files, a key, type and name a row:{' '}
            {(['things.csv', 'connections.csv'] as const).map((name, i) => (
              <span key={name}>
                {i > 0 && ' · '}
                <button onClick={() => downloadSimpleTemplate(name)}
                  className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                  {name}
                </button>
              </span>
            ))}
          </p>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
          <Lock className="w-3.5 h-3.5 text-ink-muted mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Include only the <span className="font-medium text-ink-secondary">rows and columns you're changing</span> — everything else is left untouched, so you can update one property across 50 rows of 10,000. Keep the greyed <span className="font-medium text-ink-secondary">entity_id</span> / <span className="font-medium text-ink-secondary">urn</span> as-is (they match the row); <span className="font-mono text-ink-secondary">_op=delete</span> removes an entity, <span className="font-mono text-ink-secondary">\N</span> in a cell clears a property.
          </p>
        </div>
      </div>

      {/* Right — the action */}
      <div className="px-8 py-6 space-y-5">
        <input ref={inputRef} type="file" multiple className="hidden" onChange={intake.onPick} />

        {!files.length ? (
          <button
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={intake.onDrop}
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
              <p className="text-[11px] text-ink-muted mt-1">Excel, CSV, TSV, NDJSON or JSON · up to millions of rows</p>
            </div>
          </button>
        ) : (
          <div className="space-y-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
            {files.map((file) => (
              <div key={`${file.name}:${file.lastModified}`} className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center flex-shrink-0">
                  <FileUp className="w-5 h-5 text-indigo-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink truncate">{file.name}</p>
                  <p className="text-[11px] text-ink-muted mt-0.5">{prettyBytes(file.size)}</p>
                </div>
                <button onClick={() => intake.remove(file)} aria-label={`Remove ${file.name}`} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            {read?.format === 'simple' && files.length < 2 && !(read.things.length && read.connections.length) && (
              <button onClick={() => inputRef.current?.click()}
                className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                Add a {read.connections.length ? 'things' : 'connections'} file too
              </button>
            )}

            {reading && <p className="text-[11px] text-ink-muted flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Reading…</p>}
            {read && <FileNote read={read} files={files} types={types} />}
            {warning ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-amber-700 dark:text-amber-400">{warning}</p>
              </div>
            ) : read?.passthrough && (
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
        {errors.length > 0 && (
          <div role="alert" className="space-y-1 rounded-lg border border-rose-200 dark:border-rose-800/50 bg-rose-50/60 dark:bg-rose-950/20 px-3 py-2">
            {errors.map((e) => <p key={e} className="text-[11px] text-rose-700 dark:text-rose-400">{e}</p>)}
          </div>
        )}

        {options}
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

// ── running ──────────────────────────────────────────────────────────────────
function RunningStep({ job, upload, fileName }: {
  job: Job | null
  upload: { sent: number; total: number } | null
  fileName?: string
}) {
  const queued = queuePosition(job)
  const phaseLabel = !job
    ? (upload ? `Uploading… ${prettyBytes(upload.sent)} of ${prettyBytes(upload.total)}` : 'Uploading…')
    : queued ? 'Waiting to start…' : job.status === 'pending' ? 'Starting…' : jobProgressText(job) ?? 'Reconciling changes…'
  const note = resumeNote(job)
  const pct = !job && upload && upload.total > 0 ? Math.round((100 * upload.sent) / upload.total) : null
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
        {queued && <p className="text-[11px] text-ink-muted mt-1">{queued}</p>}
        {note && <p className="text-[11px] text-ink-muted mt-1">{note}</p>}
        <p className="text-[11px] text-ink-muted mt-1 truncate max-w-[24rem]">{fileName}</p>
      </div>
      <div className="w-full max-w-sm h-1 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
        {pct != null
          ? <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
              className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600 transition-[width]"
              style={{ width: `${pct}%` }} />
          : <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600 animate-pulse" />}
      </div>
      <p className="text-[11px] text-ink-muted">
        {/* No close and no Cancel while a job runs: the dialog stays until it ends, and says so. */}
        {job
          ? 'Keep this open until it finishes — the import runs on the server.'
          : 'Keep this open while the file uploads. If it stops, choose the same file again to pick up where it left off.'}
      </p>
    </div>
  )
}

// ── done ─────────────────────────────────────────────────────────────────────
function DoneStep({ summary, previewRows, identifier, wsId, graphId, jobId }: {
  summary: ImportSummary | null
  previewRows: ImportPreviewRow[]
  /** What its rows found their items by. */
  identifier: string | null
  wsId: string
  graphId: string
  jobId: string | null
}) {
  const s = summary
  const changes = s ? s.new + s.updated + s.deleted : 0
  const nothing = s != null && changes === 0
  return (
    <div className="px-8 py-8 max-w-2xl mx-auto">
      <div className="flex items-start gap-4">
        <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
          nothing ? 'bg-slate-100 dark:bg-slate-800 text-ink-muted' : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500')}>
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-ink">
            {nothing ? 'No changes to apply' : `${changes} change${changes === 1 ? '' : 's'} ready to review`}
          </h3>
          <p className="text-sm text-ink-muted mt-1">
            {nothing
              ? 'Your data already matches the file — nothing was staged.'
              : 'Staged on your draft. The canvas and the Changes tab show them when this closes — review, then publish or open a pull request.'}
          </p>
        </div>
      </div>

      {s && (
        <div className="mt-6 grid grid-cols-4 gap-3">
          <Stat n={s.new} label="New" icon={<Plus className="w-4 h-4" />} tone="emerald" />
          <Stat n={s.updated} label="Updated" icon={<Pencil className="w-4 h-4" />} tone="blue" />
          <Stat n={s.deleted} label="Deleted" icon={<Trash2 className="w-4 h-4" />} tone="rose" />
          <Stat n={s.invalid} label="Needs fixing" icon={<AlertTriangle className="w-4 h-4" />} tone="amber" />
        </div>
      )}
      {s?.refused && <RefusedRowsPanel report={s.refused} wsId={wsId} graphId={graphId} jobId={jobId} />}
      {s && (s.unchanged ?? 0) > 0 && (
        <p className="mt-3 text-[11px] text-ink-muted">
          {s.unchanged} row{s.unchanged === 1 ? ' was' : 's were'} already up to date — only real changes are staged.
        </p>
      )}
      {identifier && (
        <p className="mt-1 text-[11px] text-ink-muted">
          Matched existing items by {identifierLabel(identifier)}. Every matched item kept its id and history.
        </p>
      )}

      {/* Deletions are destructive — name the exact count and route the user to review before they
          publish. Nothing is removed from the published model until then. */}
      {s && s.deleted > 0 && (
        <div className="mt-5 rounded-xl border border-rose-300 dark:border-rose-800/60 bg-rose-50/60 dark:bg-rose-950/25 px-4 py-3 flex items-start gap-2.5">
          <Trash2 className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-rose-700 dark:text-rose-400">
              {s.deleted} {s.deleted === 1 ? 'entity' : 'entities'} will be deleted when you publish
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5">
              Replace removes items not in your file. They're only staged for now — review every deletion
              in the Changes tab before you publish; nothing is removed until then.
              {!!s.edgesCascaded && <>
                {' '}{s.edgesCascaded.toLocaleString()} {s.edgesCascaded === 1 ? 'edge goes' : 'edges go'} with
                them, to items outside what the file replaces: an edge never outlives its ends.
              </>}
            </p>
          </div>
        </div>
      )}

      {/* A real preview of what changed — each staged add / update / delete and, with its exact
          reason, anything that couldn't be applied. So the user sees the changes here, not a blank. */}
      {previewRows.length > 0 && (
        <div className="mt-5 rounded-xl border border-glass-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-glass-border/60 bg-black/[0.02] dark:bg-white/[0.02]">
            <span className="text-xs font-semibold text-ink">Preview of changes</span>
          </div>
          <ul className="divide-y divide-glass-border/50 max-h-64 overflow-y-auto">
            {previewRows.slice(0, 10).map((r) => (
              <li key={r.rowIndex} className="flex items-start gap-3 px-4 py-2">
                <PreviewIcon status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-ink truncate">{r.label || `Row ${r.rowIndex + 1}`}</span>
                    <span className="text-[10px] uppercase tracking-wide text-ink-muted flex-shrink-0">{r.kind}</span>
                  </div>
                  {/* Why a row was refused — or a note on one that applied (e.g. a urn it doesn't store). */}
                  {r.reasons?.[0] && (
                    <p className={cn('text-[11px] mt-0.5 leading-relaxed', r.status === 'invalid'
                      ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted')}>{r.reasons[0]}</p>
                  )}
                </div>
                <span className={cn('text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 mt-0.5', PREVIEW_TONE[r.status || ''] || 'text-ink-muted')}>
                  {PREVIEW_LABEL[r.status || ''] || r.status}
                </span>
              </li>
            ))}
            {previewRows.length > 10 && (
              <li className="px-4 py-2 text-[11px] text-ink-muted">
                + {previewRows.length - 10} more — see the full diff in the Changes tab
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

const PREVIEW_TONE: Record<string, string> = {
  new: 'text-emerald-500', updated: 'text-blue-500', deleted: 'text-rose-500', invalid: 'text-amber-500',
}
const PREVIEW_LABEL: Record<string, string> = {
  new: 'New', updated: 'Updated', deleted: 'Deleted', invalid: 'Skipped',
}

function PreviewIcon({ status }: { status?: string | null }) {
  const cls = 'w-3.5 h-3.5 mt-0.5 flex-shrink-0'
  if (status === 'new') return <Plus className={cn(cls, 'text-emerald-500')} />
  if (status === 'updated') return <Pencil className={cn(cls, 'text-blue-500')} />
  if (status === 'deleted') return <Trash2 className={cn(cls, 'text-rose-500')} />
  if (status === 'invalid') return <AlertTriangle className={cn(cls, 'text-amber-500')} />
  return <span className={cn(cls, 'rounded-full bg-ink-muted/40')} />
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
function FailedStep({ error, job, wsId, graphId }: {
  error: string | null
  job: Job | null
  wsId: string
  graphId: string
}) {
  return (
    <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-500 flex items-center justify-center flex-shrink-0">
        <AlertTriangle className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg font-bold text-ink">Import didn't complete</h3>
        <p className="text-sm text-ink-muted mt-1 break-words">{error}</p>
        {blocked(job) && (
          <p className="text-[11px] text-ink-muted mt-3 leading-relaxed">
            Try again with another way to match existing items, or replace anyway to delete what the
            file leaves out: the deletions are staged on your draft, to review before you publish.
          </p>
        )}
        {byUrnFix(job) && (
          <p className="text-[11px] text-ink mt-3 leading-relaxed rounded-lg bg-indigo-50/70 dark:bg-indigo-950/25 border border-indigo-200/70 dark:border-indigo-800/40 px-3 py-2">
            <span className="font-semibold">{(refusedOf(job)?.hints?.by_urn ?? 0).toLocaleString()} of these rows
            would be found by their urn</span>: rows without {parseIdentifier(job!.identifier!).name}, such as a
            top-level container, or items first loaded by urn. <span className="font-semibold">Find them by their
            urn</span> to import them too: they keep their ids, and take the property, so the next import finds
            them by it.
          </p>
        )}
        {refusedOf(job) && <RefusedRowsPanel report={refusedOf(job)!} wsId={wsId} graphId={graphId} jobId={job?.jobId} />}
        {heldForRows(job) && (
          <p className="text-[11px] text-ink-muted mt-3 leading-relaxed">
            Fix those rows and try again, or import the rest anyway: the replace goes on without them,
            keeping what a refused row still names, and the deletions are staged on your draft, to
            review before you publish.
          </p>
        )}
      </div>
    </div>
  )
}
