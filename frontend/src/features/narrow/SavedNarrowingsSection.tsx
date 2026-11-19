/**
 * SavedNarrowingsSection — the narrowings saved with this view, for everyone who can open it.
 *
 * A row opens its narrowing against the data as it is now, and says what is new and gone
 * since it was saved; a link hands it on; Export writes everything it shows to a file. Its
 * saver, or an editor of the view, renames or removes it. The one who saved it in this
 * browser also has its results as they were then, to download without asking again.
 *
 * Shown from the header (`SavedNarrowingsButton`) whenever the view has any. Purely
 * presentational: rows arrive resolved, every action is a callback.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, FileArchive, Link2, Pencil, ScanSearch, Trash2 } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { relativeTime } from '@/lib/relativeTime'
import { cn } from '@/lib/utils'

export interface SavedNarrowingItem {
  id: string
  name: string
  /** When it was last saved (ms since the epoch). */
  savedAt: number | null
  /** What it shows, in words. */
  sentence: string
  /** How many it held when saved. */
  held: number
  /** The caller saved it, or may edit the view. */
  canChange: boolean
  /** It is the narrowing on screen. */
  active: boolean
  /** Its results as they were when saved are kept in this browser. */
  hasCopy: boolean
}

export interface SavedNarrowingsSectionProps {
  items: SavedNarrowingItem[]
  onOpen: (id: string) => void
  onCopyLink: (id: string) => string
  onExport: (id: string) => void
  onDownloadCopy: (id: string) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  /** The list couldn't be read: said, with a way to ask again. */
  error?: string | null
  onRetry?: () => void
}

const iconButton = cn(
  'inline-flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0 transition-colors',
  'text-ink-muted/60 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
)

export function SavedNarrowingsSection({ items, onOpen, onCopyLink, onExport, onDownloadCopy, onRename, onRemove, error, onRetry }: SavedNarrowingsSectionProps) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(onCopyLink(id))
      setCopied(id)
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800)
    } catch {
      setCopied(null)
    }
  }
  const commitRename = () => {
    if (editing && editing.name.trim()) onRename(editing.id, editing.name.trim())
    setEditing(null)
  }

  return (
    <section aria-label="Saved narrowings" data-saved-narrowings>
      <div className="px-3.5 pt-2 pb-1">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <ScanSearch className="w-3 h-3" /> Saved with this view
        </span>
      </div>
      {error && (
        <p role="alert" className="px-3.5 pb-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {error}
          {onRetry && (
            <button type="button" onClick={onRetry} className="ml-1.5 font-semibold underline underline-offset-2">Try again</button>
          )}
        </p>
      )}
      <ul className="max-h-[280px] overflow-y-auto pb-1">
        {items.map((t) => {
          const isEditing = editing?.id === t.id
          return (
            <li
              key={t.id}
              data-saved-narrowing={t.id}
              className={cn(
                'flex items-center gap-1.5 pl-3.5 pr-2 py-1.5',
                t.active ? 'bg-accent-lineage/[0.07]' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
              )}
            >
              {isEditing ? (
                <input
                  autoFocus
                  aria-label="Name this saved narrowing"
                  value={editing.name}
                  maxLength={120}
                  onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
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
                  onClick={() => onOpen(t.id)}
                  title={`Open “${t.name}” — ${t.sentence}, on the data as it is now`}
                  className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:underline"
                >
                  <span className="block truncate text-xs font-medium text-ink">{t.name}</span>
                  <span className="block truncate text-[10px] text-ink-muted tabular-nums">
                    {t.held.toLocaleString()} when saved{t.savedAt ? ` · ${relativeTime(t.savedAt)}` : ''}
                  </span>
                </button>
              )}
              {!isEditing && (
                <>
                  {t.hasCopy && (
                    <button type="button" className={iconButton} aria-label={`Download ${t.name} as it was saved`} title="As it was saved — kept in this browser" onClick={() => onDownloadCopy(t.id)}>
                      <FileArchive className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button type="button" className={iconButton} aria-label={`Export ${t.name}`} title="Export what it shows now" onClick={() => onExport(t.id)}>
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className={cn(iconButton, copied === t.id && 'text-emerald-500')} aria-label={copied === t.id ? 'Link copied' : `Copy a link to ${t.name}`} title="Copy its short link" onClick={() => { void copy(t.id) }}>
                    {copied === t.id ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                  </button>
                  {t.canChange && (
                    <>
                      <button type="button" className={iconButton} aria-label={`Rename ${t.name}`} title="Rename" onClick={() => setEditing({ id: t.id, name: t.name })}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" className={cn(iconButton, 'hover:text-rose-500')} aria-label={`Remove ${t.name}`} title="Remove it — for everyone" onClick={() => onRemove(t.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>
      <span aria-live="polite" role="status" className="sr-only">{copied ? 'Link copied' : ''}</span>
    </section>
  )
}

/** The header's way to them: shown while the view has any. */
export function SavedNarrowingsButton(props: SavedNarrowingsSectionProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  if (props.items.length === 0 && !props.error) return null
  const toggle = () => {
    const rect = trigger.current?.getBoundingClientRect()
    if (rect) setAnchor({ right: window.innerWidth - rect.right, top: rect.bottom + 8 })
    setOpen((o) => !o)
  }
  const closing = <T extends unknown[]>(fn: (...a: T) => void) => (...a: T) => { setOpen(false); fn(...a) }

  return (
    <>
      <HoverTip className="inline-flex" label="Saved narrowings" detail="Narrowings saved with this view — open one to see what is new and gone since.">
        <button
          ref={trigger}
          type="button"
          aria-label={props.error && props.items.length === 0 ? 'Saved narrowings (couldn’t load)' : `Saved narrowings (${props.items.length})`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
          className={cn(
            'flex items-center gap-1 h-9 px-2.5 rounded-xl border text-sm transition-colors',
            'border-glass-border text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
            open && 'text-accent-lineage border-accent-lineage/40',
          )}
        >
          <ScanSearch className="w-4 h-4" strokeWidth={2.2} />
          <span className="text-[11px] font-semibold tabular-nums">{props.error && props.items.length === 0 ? '!' : props.items.length}</span>
        </button>
      </HoverTip>
      {open && anchor && createPortal(
        <div
          ref={panel}
          role="dialog"
          aria-label="Saved narrowings"
          data-canvas-interactive
          style={{ position: 'fixed', right: anchor.right, top: anchor.top, zIndex: 1000 }}
          className="w-[320px] py-1.5 rounded-xl overflow-hidden bg-canvas-elevated/98 backdrop-blur-2xl border border-glass-border shadow-glass-lg"
        >
          <SavedNarrowingsSection
            {...props}
            onOpen={closing(props.onOpen)}
            onExport={closing(props.onExport)}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
