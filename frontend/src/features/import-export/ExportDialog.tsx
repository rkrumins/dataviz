/**
 * ExportDialog — export a data source's graph to a downloadable file in the format the user picks.
 *
 * Strategic symmetry with import: whatever format you export (CSV / TSV / NDJSON / JSON) downloads
 * with the correct extension and re-imports losslessly. A large two-column guided modal that
 * mirrors the ImportDialog's scale — a persistent "what you're exporting" guide + the format choice.
 */
import { useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Database, Download, FileDown, GitCompareArrows,
  Layers, Loader2, RefreshCw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { exportAndDownload, type ImportFormat } from '@/services/importExportApiService'

export interface ExportDialogProps {
  wsId: string
  graphId: string
  viewId?: string
  onClose: () => void
}

type Phase = 'choose' | 'running' | 'done' | 'failed'

const FORMATS: { id: ImportFormat; label: string; hint: string }[] = [
  { id: 'xlsx', label: 'Excel', hint: 'Nodes + Edges sheets, locked columns · best for editing' },
  { id: 'csv', label: 'CSV', hint: 'Universal · opens in any spreadsheet or editor' },
  { id: 'tsv', label: 'TSV', hint: 'Tab-separated · safest for text with commas' },
  { id: 'ndjson', label: 'NDJSON', hint: 'One JSON object per line · streams at scale' },
  { id: 'json', label: 'JSON', hint: 'A single JSON array · for tools & scripts' },
]

export function ExportDialog({ wsId, graphId, viewId, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [scope, setScope] = useState<'view' | 'all'>(viewId ? 'view' : 'all')
  const [newProps, setNewProps] = useState('')
  const [phase, setPhase] = useState<Phase>('choose')
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setPhase('running')
    setError(null)
    try {
      const props = newProps.split(',').map((s) => s.trim()).filter(Boolean)
      await exportAndDownload(wsId, graphId, { format, viewId: scope === 'view' ? viewId : undefined, props })
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be completed.')
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
              <FileDown className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-ink">Export data</h3>
              <p className="text-xs text-ink-muted mt-0.5">Download the graph — a complete, re-importable backup</p>
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
            <ChooseStep format={format} setFormat={setFormat} scope={scope} setScope={setScope}
              hasView={!!viewId} newProps={newProps} setNewProps={setNewProps} />
          )}
          {phase === 'running' && (
            <div className="px-8 py-16 flex flex-col items-center gap-4">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
                <div className="relative w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
                  <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
                </div>
              </div>
              <p className="text-sm font-semibold text-ink">Preparing your {format.toUpperCase()} export…</p>
              <p className="text-[11px] text-ink-muted">This runs in the background — your download will start automatically.</p>
            </div>
          )}
          {phase === 'done' && (
            <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Downloaded</h3>
                <p className="text-sm text-ink-muted mt-1">
                  Saved <span className="font-medium text-ink">graph-export.{format}</span>. Re-import it any time to restore
                  this data source, or into a new one to clone it — it round-trips losslessly.
                </p>
              </div>
            </div>
          )}
          {phase === 'failed' && (
            <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-500 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-ink">Export didn't complete</h3>
                <p className="text-sm text-ink-muted mt-1 break-words">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-8 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
          {phase === 'done' && (
            <button onClick={() => setPhase('choose')} className="mr-auto px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              Export again
            </button>
          )}
          <button onClick={onClose} disabled={phase === 'running'} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
            {phase === 'done' ? 'Done' : 'Cancel'}
          </button>
          {phase === 'choose' && (
            <button onClick={run}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20">
              <Download className="w-4 h-4" /> Export {format.toUpperCase()}
            </button>
          )}
          {phase === 'failed' && (
            <button onClick={run}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── choose (two columns: guide | scope + format) ─────────────────────────────
function ChooseStep({ format, setFormat, scope, setScope, hasView, newProps, setNewProps }: {
  format: ImportFormat; setFormat: (f: ImportFormat) => void
  scope: 'view' | 'all'; setScope: (s: 'view' | 'all') => void; hasView: boolean
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
          <Feature icon={<Layers className="w-4 h-4" />} title="Locked identity columns" body="entity_id / urn travel with each row so a re-import matches the right items — no duplicates." />
          <Feature icon={<GitCompareArrows className="w-4 h-4" />} title="A re-importable backup" body="Restore this data source, or import into a new one to clone it. Round-trips losslessly." />
        </ul>
        <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Edit the file in Excel, Sheets, or any editor, then use <span className="font-medium text-ink-secondary">Import</span> to apply your changes — reviewed before anything is published.
          </p>
        </div>
      </div>

      {/* Right — scope + format */}
      <div className="px-8 py-6 space-y-5">
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
