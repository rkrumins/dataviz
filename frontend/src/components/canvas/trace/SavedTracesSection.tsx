/**
 * SavedTracesSection — the traces this reader saved in this view, kept in
 * this browser (2026-11-18).
 *
 * Shown where traces are picked up: the dock's Export & save menu, and the
 * header's trace launcher (the way in when no trace is running). A row opens
 * its trace against live data; a saved copy of its results exports without a
 * walk; a link hands the question on; a name says what it was for.
 *
 * Purely presentational: rows arrive resolved, every action is a callback.
 */
import { useState } from 'react'
import { ArrowDownRight, ArrowUpLeft, Bookmark, Check, FileJson, FileSpreadsheet, GitBranch, Link2, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relativeTime'

export interface SavedTraceItem {
  id: string
  name: string
  savedAt: number
  seeds: number
  mode: 'up' | 'down' | 'both'
  /** Rows its saved results hold. */
  rows: number
  /** Its results were kept (false: opening it is the only way to see them). */
  hasResults: boolean
  /** It was saved before its walk finished. */
  partial: boolean
  /** It is the trace on screen. */
  active: boolean
}

export interface SavedTracesSectionProps {
  items: SavedTraceItem[]
  /** False: this browser keeps nothing, and the list lasts for this visit. */
  persistent: boolean
  onOpen: (id: string) => void
  onExport: (id: string, format: 'csv' | 'json') => void
  onCopyLink: (id: string) => string | null
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}

const MODE = {
  up: { Icon: ArrowUpLeft, tone: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10' },
  down: { Icon: ArrowDownRight, tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10' },
  both: { Icon: GitBranch, tone: 'text-violet-600 dark:text-violet-400 bg-violet-500/10' },
} as const

const iconButton = cn(
  'inline-flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0 transition-colors',
  'text-ink-muted/60 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
)

export function SavedTracesSection({ items, persistent, onOpen, onExport, onCopyLink, onRename, onRemove }: SavedTracesSectionProps) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (id: string) => {
    const link = onCopyLink(id)
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(id)
      window.setTimeout(() => setCopied(c => (c === id ? null : c)), 1800)
    } catch {
      setCopied(null)
    }
  }
  const commitRename = () => {
    if (editing) onRename(editing.id, editing.name)
    setEditing(null)
  }

  return (
    <section aria-label="Saved traces" data-saved-traces>
      <div className="px-3.5 pt-2 pb-1 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <Bookmark className="w-3 h-3" /> Saved in this browser
        </span>
        {!persistent && <span className="text-[10px] text-amber-700 dark:text-amber-400">This visit only</span>}
      </div>
      {items.length === 0 ? (
        <p className="px-3.5 pb-2 text-[11px] leading-snug text-ink-muted">
          Save a trace to keep it — with what it found — and open, export or compare it later.
        </p>
      ) : (
        <ul className="max-h-[220px] overflow-y-auto pb-1">
          {items.map((t) => {
            const mode = MODE[t.mode]
            const isEditing = editing?.id === t.id
            return (
              <li
                key={t.id}
                data-saved-trace={t.id}
                className={cn(
                  'group/saved flex items-center gap-1.5 pl-3.5 pr-2 py-1.5',
                  t.active ? 'bg-accent-lineage/[0.07]' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
                )}
              >
                <span className={cn('flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0', mode.tone)}>
                  <mode.Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
                </span>
                {isEditing ? (
                  <input
                    autoFocus
                    aria-label="Name this saved trace"
                    value={editing.name}
                    maxLength={120}
                    onChange={e => setEditing({ id: t.id, name: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null) }
                    }}
                    className="flex-1 min-w-0 px-1.5 py-0.5 rounded text-xs bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border text-ink"
                  />
                ) : (
                  <button
                    type="button"
                    data-saved-open
                    onClick={() => onOpen(t.id)}
                    title={`Open “${t.name}” — it runs again against today’s lineage`}
                    className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:underline"
                  >
                    <span className="block truncate text-xs font-medium text-ink">{t.name}</span>
                    <span className="block truncate text-[10px] text-ink-muted tabular-nums">
                      {t.seeds > 1 ? `${t.seeds} entities · ` : ''}
                      {t.hasResults ? `${t.rows.toLocaleString()} rows kept` : 'recipe only'}
                      {t.partial ? ' (partial)' : ''} · {relativeTime(t.savedAt)}
                    </span>
                  </button>
                )}
                {t.hasResults && !isEditing && (
                  <>
                    <button type="button" className={iconButton} aria-label={`Download the saved results of ${t.name} as CSV`} title="Saved results as CSV" onClick={() => onExport(t.id, 'csv')}>
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" className={iconButton} aria-label={`Download the saved results of ${t.name} as JSON`} title="Saved results as JSON" onClick={() => onExport(t.id, 'json')}>
                      <FileJson className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {!isEditing && (
                  <>
                    <button type="button" className={cn(iconButton, copied === t.id && 'text-emerald-500')} aria-label={copied === t.id ? 'Link copied' : `Copy a link to ${t.name}`} title="Copy a link to this trace" onClick={() => { void copy(t.id) }}>
                      {copied === t.id ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                    </button>
                    <button type="button" className={iconButton} aria-label={`Rename ${t.name}`} title="Rename" onClick={() => setEditing({ id: t.id, name: t.name })}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" className={cn(iconButton, 'hover:text-rose-500')} aria-label={`Remove ${t.name} from saved traces`} title="Remove" onClick={() => onRemove(t.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <span aria-live="polite" role="status" className="sr-only">{copied ? 'Link copied' : ''}</span>
    </section>
  )
}
