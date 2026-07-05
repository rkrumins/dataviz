/**
 * ExportDialog — export a data source's graph to a downloadable file in the format the user picks.
 *
 * Strategic symmetry with import: whatever format you export (CSV / TSV / NDJSON / JSON) downloads
 * with the correct extension and re-imports losslessly. Matches the ImportDialog's glass design.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileDown, Loader2, RefreshCw, X } from 'lucide-react'
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
  { id: 'csv', label: 'CSV', hint: 'Opens in Excel / Sheets · best for editing' },
  { id: 'tsv', label: 'TSV', hint: 'Tab-separated · safest for text with commas' },
  { id: 'ndjson', label: 'NDJSON', hint: 'One JSON object per line · streams at scale' },
  { id: 'json', label: 'JSON', hint: 'A single JSON array · for tools & scripts' },
]

export function ExportDialog({ wsId, graphId, viewId, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [phase, setPhase] = useState<Phase>('choose')
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setPhase('running')
    setError(null)
    try {
      await exportAndDownload(wsId, graphId, { format, viewId })
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be completed.')
      setPhase('failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={phase === 'running' ? undefined : onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center">
                <FileDown className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Export data</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">Download the graph — a re-importable backup</p>
              </div>
            </div>
            {phase !== 'running' && (
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {phase === 'choose' && (
          <>
            <div className="px-6 py-5">
              <label className="block text-xs font-medium text-ink-secondary mb-2">Choose a format</label>
              <div className="space-y-2">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    className={cn('w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
                      format === f.id
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                        : 'border-glass-border hover:border-glass-border-hover')}
                  >
                    <div className="flex items-center gap-3">
                      <span className={cn('text-[11px] font-bold w-14 flex-shrink-0',
                        format === f.id ? 'text-indigo-500' : 'text-ink-muted')}>{f.label}</span>
                      <span className="text-[11px] text-ink-muted flex-1">{f.hint}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Cancel
              </button>
              <button
                onClick={run}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
              >
                <Download className="w-4 h-4" /> Export {format.toUpperCase()}
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <div className="px-6 py-10 flex flex-col items-center gap-4">
            <div className="relative w-14 h-14">
              <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
              <div className="relative w-14 h-14 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
              </div>
            </div>
            <p className="text-sm font-semibold text-ink">Preparing your {format.toUpperCase()} export…</p>
          </div>
        )}

        {phase === 'done' && (
          <>
            <div className="px-6 py-6 flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-ink">Downloaded</h3>
                <p className="text-sm text-ink-muted mt-1">
                  Saved <span className="font-medium text-ink">graph-export.{format}</span> — re-import it any time to restore.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
              <button onClick={() => setPhase('choose')} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Export again
              </button>
              <button onClick={onClose} className="px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                Done
              </button>
            </div>
          </>
        )}

        {phase === 'failed' && (
          <>
            <div className="px-6 py-6 flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-500 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-ink">Export didn't complete</h3>
                <p className="text-sm text-ink-muted mt-1 break-words">{error}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Close
              </button>
              <button onClick={run} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                <RefreshCw className="w-4 h-4" /> Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
