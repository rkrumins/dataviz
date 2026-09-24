/**
 * ExportDialog — export a data source's graph to a downloadable file in the format the user picks.
 *
 * Strategic symmetry with import: whatever format you export (Excel / CSV / TSV / NDJSON / JSON)
 * downloads with the correct extension and re-imports losslessly. A large two-column guided modal
 * that mirrors the ImportDialog's scale — a persistent "what you're exporting" guide + the choices.
 *
 * It first asks the server what the export would hold (the plan), so an empty export or one the
 * format can't hold is explained instead of downloaded; then the browser downloads the file as the
 * server writes it, at any size. A data source without version control exports its live graph, in
 * view and edit mode alike: a cold copy, importable later into one with version control.
 */
import { useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Database, Download, FileDown, GitCompareArrows,
  Info, Layers, Loader2, RefreshCw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import {
  exportStreamUrl, planExport, triggerBrowserDownload,
  type ExportPlan, type ExportTarget, type ImportFormat,
} from '@/services/importExportApiService'
import { recordEvent } from '@/services/telemetryService'

export interface ExportDialogProps {
  wsId: string
  dataSourceId: string
  /** The data source's versioned graph; `null` when it has no version control (a live export). */
  graphId: string | null
  /** Names the downloaded file. */
  dataSourceName?: string
  viewId?: string
  viewName?: string
  branchId?: string   // present when the user is on a working draft branch → offer to include it
  onClose: () => void
}

type Phase = 'choose' | 'checking' | 'started' | 'empty' | 'limit' | 'failed'

const FORMATS: { id: ImportFormat; label: string; hint: string }[] = [
  { id: 'xlsx', label: 'Excel', hint: 'Nodes + Edges sheets, locked columns · best for editing' },
  { id: 'csv', label: 'CSV', hint: 'Universal · opens in any spreadsheet or editor' },
  { id: 'tsv', label: 'TSV', hint: 'Tab-separated · safest for text with commas' },
  { id: 'ndjson', label: 'NDJSON', hint: 'One JSON object per line · streams at scale' },
  { id: 'json', label: 'JSON', hint: 'A single JSON array · for tools & scripts' },
]

const SPREADSHEETS: ImportFormat[] = ['xlsx', 'csv', 'tsv']

/** A file name the server and every OS accept (a view named like its data source says it once). */
function fileStem(parts: Array<string | undefined>): string {
  const stem = [...new Set(parts.filter(Boolean))].join(' ').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return stem || 'graph-export'
}

const count = (n: number) => n.toLocaleString()

export function ExportDialog({
  wsId, dataSourceId, graphId, dataSourceName, viewId, viewName, branchId, onClose,
}: ExportDialogProps) {
  const live = !graphId
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [scope, setScope] = useState<'view' | 'all'>(viewId && !live ? 'view' : 'all')
  const [source, setSource] = useState<'branch' | 'published'>(branchId && !live ? 'branch' : 'published')
  const [newProps, setNewProps] = useState('')
  const [phase, setPhase] = useState<Phase>('choose')
  const [plan, setPlan] = useState<ExportPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const inView = !live && scope === 'view' && !!viewId
  const onDraft = !live && source === 'branch' && !!branchId

  async function run(fmt: ImportFormat = format) {
    setFormat(fmt)
    setPhase('checking')
    setError(null)
    const target: ExportTarget = {
      wsId, dataSourceId, graphId,
      viewId: inView ? viewId : undefined,
      branchId: onDraft ? branchId : undefined,
    }
    try {
      const planned = await planExport(target, fmt)
      setPlan(planned)
      if (planned.empty) { setPhase('empty'); return }
      if (planned.formatLimit) { setPhase('limit'); return }
      const stem = fileStem([dataSourceName, inView ? viewName : undefined, onDraft ? 'draft' : undefined])
      const props = SPREADSHEETS.includes(fmt)
        ? newProps.split(',').map((s) => s.trim()).filter(Boolean) : []
      // The browser saves the file as the server writes it: nothing is held in this page.
      triggerBrowserDownload(exportStreamUrl(target, fmt, { props, filename: stem }), `${stem}.${fmt}`)
      setFileName(`${stem}.${fmt}`)
      // Recorded when the download starts. Format and scope, never the property list: those
      // are the user's column names.
      recordEvent('graph.export', {
        format: fmt,
        scope: inView ? 'view' : 'graph',
        source: live ? 'live' : onDraft ? 'branch' : 'published',
      })
      setPhase('started')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be started.')
      setPhase('failed')
    }
  }

  const busy = phase === 'checking'
  return (
    <>
    <Backdrop open={true} onClick={busy ? undefined : onClose} zClassName="z-50" className="bg-black/50 backdrop-blur-sm" />
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div role="dialog" aria-label="Export data" className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden pointer-events-auto">
        {/* Header */}
        <div className="border-b border-glass-border/50 px-8 py-5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <FileDown className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-ink">Export data</h3>
              <p className="text-xs text-ink-muted mt-0.5">
                {live ? 'Download the graph — a cold copy you can import again later'
                  : 'Download the graph — a complete, re-importable backup'}
              </p>
            </div>
          </div>
          {!busy && (
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {phase === 'choose' && (
            <ChooseStep format={format} setFormat={setFormat} scope={scope} setScope={setScope}
              hasView={!!viewId && !live} source={source} setSource={setSource} hasBranch={!!branchId && !live}
              live={live} newProps={newProps} setNewProps={setNewProps} />
          )}
          {phase === 'checking' && (
            <div className="px-8 py-16 flex flex-col items-center gap-4">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
                <div className="relative w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
                  <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
                </div>
              </div>
              <p className="text-sm font-semibold text-ink">Checking what the {format.toUpperCase()} export will hold…</p>
            </div>
          )}
          {phase === 'started' && plan && (
            <Outcome tone="ok" title="Your download has started">
              <p>
                <span className="font-medium text-ink">{fileName}</span>{' '}
                {plan.nodes != null && plan.edges != null
                  ? <>holds {plan.exact ? '' : 'about '}{count(plan.nodes)} entities and {count(plan.edges)} relationships.</>
                  : <>is a large export, too large to count up front.</>}
                {' '}Your browser shows its progress; a large one takes a few minutes, and you can close this
                dialog while it downloads. If other exports are running, it waits for its turn first: your
                browser shows it once it begins.
              </p>
              {inView && plan.view?.placements === 0 && (
                <p className="mt-2">This view places no entities of its own, so the export covers the whole data source.</p>
              )}
              <p className="mt-2">
                {live
                  ? 'Import it into a data source with version control to restore it there: its rows are matched by URN.'
                  : 'Re-import it any time to restore this data source, or into a new one to clone it — it round-trips losslessly.'}
              </p>
            </Outcome>
          )}
          {phase === 'empty' && (
            <Outcome tone="info" title="Nothing to export">
              <p>{emptyReason(plan, { inView, onDraft })}</p>
            </Outcome>
          )}
          {phase === 'limit' && plan && (
            <Outcome tone="warn" title={`Too large for ${format.toUpperCase()}`}>
              <p>{plan.formatLimit}</p>
            </Outcome>
          )}
          {phase === 'failed' && (
            <Outcome tone="error" title="The export didn't start">
              <p className="break-words">{error}</p>
            </Outcome>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-8 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
          {(phase === 'started' || phase === 'empty' || phase === 'limit') && (
            <button onClick={() => setPhase('choose')} className="mr-auto px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              {phase === 'started' ? 'Export again' : 'Change what to export'}
            </button>
          )}
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
            {phase === 'choose' || busy || phase === 'failed' ? 'Cancel' : 'Done'}
          </button>
          {phase === 'choose' && (
            <button onClick={() => run()}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20">
              <Download className="w-4 h-4" /> Export {format.toUpperCase()}
            </button>
          )}
          {phase === 'limit' && (
            <button onClick={() => run('csv')}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
              <Download className="w-4 h-4" /> Export CSV instead
            </button>
          )}
          {phase === 'failed' && (
            <button onClick={() => run()}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  )
}

/** Why an export holds nothing, in the terms the user chose it in. */
function emptyReason(plan: ExportPlan | null, { inView, onDraft }: { inView: boolean; onDraft: boolean }): string {
  const where = onDraft ? 'your draft' : 'this data source'
  if (inView && plan?.view && plan.view.placements > 0 && plan.view.found === 0) {
    const n = plan.view.placements
    return `None of the ${count(n)} ${n === 1 ? 'entity' : 'entities'} this view places ${n === 1 ? 'is' : 'are'} in ${where}, so there is nothing to export.`
  }
  return `${onDraft ? 'Your draft' : 'This data source'} has no entities yet, so there is nothing to export.`
}

function Outcome({ tone, title, children }: {
  tone: 'ok' | 'info' | 'warn' | 'error'; title: string; children: React.ReactNode
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle
  return (
    <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
      <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
        tone === 'ok' && 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500',
        tone === 'info' && 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500',
        tone === 'warn' && 'bg-amber-50 dark:bg-amber-950/30 text-amber-500',
        tone === 'error' && 'bg-rose-50 dark:bg-rose-950/30 text-rose-500')}>
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        <div className="text-sm text-ink-muted mt-1">{children}</div>
      </div>
    </div>
  )
}

// ── choose (two columns: guide | scope + format) ─────────────────────────────
function ChooseStep({ format, setFormat, scope, setScope, hasView, source, setSource, hasBranch, live, newProps, setNewProps }: {
  format: ImportFormat; setFormat: (f: ImportFormat) => void
  scope: 'view' | 'all'; setScope: (s: 'view' | 'all') => void; hasView: boolean
  source: 'branch' | 'published'; setSource: (s: 'branch' | 'published') => void; hasBranch: boolean
  live: boolean
  newProps: string; setNewProps: (s: string) => void
}) {
  return (
    <div className="grid md:grid-cols-2">
      {/* Left — what you're exporting */}
      <div className="px-8 py-6 border-b md:border-b-0 md:border-r border-glass-border/50 bg-gradient-to-br from-indigo-50/40 to-transparent dark:from-indigo-950/15 space-y-5">
        <div>
          <h4 className="text-sm font-bold text-ink">What you'll get</h4>
          <p className="text-[11px] text-ink-muted mt-0.5">A snapshot you can edit offline and re-import.</p>
        </div>
        <ul className="space-y-3">
          <Feature icon={<Database className="w-4 h-4" />} title="Entities & relationships" body={hasView ? "Everything in your chosen scope, with full properties." : "All nodes and edges, with their full properties."} />
          {live ? (
            <Feature icon={<Layers className="w-4 h-4" />} title="A cold copy" body="Each row carries its entity's URN, so importing the file into a data source with version control matches it there." />
          ) : (
            <>
              <Feature icon={<Layers className="w-4 h-4" />} title="Locked identity columns" body="entity_id / urn travel with each row so a re-import matches the right items — no duplicates." />
              <Feature icon={<GitCompareArrows className="w-4 h-4" />} title="A re-importable backup" body="Restore this data source, or import into a new one to clone it. Round-trips losslessly." />
            </>
          )}
          <Feature icon={<Download className="w-4 h-4" />} title="Any size" body="The file downloads while it is written, so even a very large graph needs no waiting for it to be built first." />
        </ul>
        <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Edit the file in Excel, Sheets, or any editor, then use <span className="font-medium text-ink-secondary">Import</span> to apply your changes — reviewed before anything is published.
          </p>
        </div>
      </div>

      {/* Right — source + scope + format */}
      <div className="px-8 py-6 space-y-5">
        {live && (
          <div className="flex items-start gap-2.5 rounded-xl border border-glass-border px-3.5 py-3">
            <Info className="w-4 h-4 mt-0.5 text-indigo-500 flex-shrink-0" />
            <p className="text-[11px] text-ink-muted leading-relaxed">
              This data source has no version control, so the export reads its graph as it stands: every
              entity and relationship in it. Changes made while it downloads may or may not be included.
            </p>
          </div>
        )}
        {hasBranch && (
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-2">Which version</label>
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard active={source === 'branch'} onClick={() => setSource('branch')}
                title="My working branch" desc="Includes your draft changes" />
              <ScopeCard active={source === 'published'} onClick={() => setSource('published')}
                title="Published" desc="The committed main graph" />
            </div>
          </div>
        )}
        {hasView && (
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-2">What to export</label>
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard active={scope === 'view'} onClick={() => setScope('view')}
                title="This view" desc="Only what this view contains" />
              <ScopeCard active={scope === 'all'} onClick={() => setScope('all')}
                title="Whole data source" desc="Every entity in the graph" />
            </div>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-2">Choose a format</label>
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <button key={f.id} onClick={() => setFormat(f.id)}
                className={cn('w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
                  format === f.id
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                    : 'border-glass-border hover:border-glass-border-hover')}>
                <div className="flex items-center gap-3">
                  <span className={cn('text-xs font-bold w-16 flex-shrink-0',
                    format === f.id ? 'text-indigo-500' : 'text-ink-muted')}>{f.label}</span>
                  <span className="text-[11px] text-ink-muted flex-1">{f.hint}</span>
                  {format === f.id && <ArrowRight className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />}
                </div>
              </button>
            ))}
          </div>
        </div>

        {SPREADSHEETS.includes(format) && (
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-1.5">Add new property columns <span className="text-ink-muted font-normal">(optional)</span></label>
          <input
            value={newProps}
            onChange={(e) => setNewProps(e.target.value)}
            placeholder="e.g. Owner, Logical Data Type, PII"
            className="w-full px-3 py-2 rounded-xl border border-glass-border bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <p className="text-[11px] text-ink-muted mt-1.5">
            Each becomes an empty <span className="font-mono">prop.&lt;name&gt;</span> column to fill in — the easy way to add a
            property. Existing properties are already included as columns.
          </p>
        </div>
        )}
      </div>
    </div>
  )
}

function ScopeCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button onClick={onClick}
      className={cn('text-left px-3 py-2.5 rounded-xl border-2 transition-colors duration-150',
        active ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10' : 'border-glass-border hover:border-glass-border-hover')}>
      <p className={cn('text-xs font-semibold', active ? 'text-ink' : 'text-ink-secondary')}>{title}</p>
      <p className="text-[10px] text-ink-muted mt-0.5">{desc}</p>
    </button>
  )
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-7 h-7 rounded-lg bg-indigo-100/70 dark:bg-indigo-900/40 text-indigo-500 flex items-center justify-center flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs font-semibold text-ink">{title}</p>
        <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{body}</p>
      </div>
    </li>
  )
}
