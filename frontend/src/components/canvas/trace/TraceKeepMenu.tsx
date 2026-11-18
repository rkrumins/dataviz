/**
 * TraceKeepMenu — take this trace with you (2026-11-18).
 *
 * Everything a reader does with a trace beyond reading it, in one place on
 * the dock: a file of what it shows (CSV for a spreadsheet, JSON with its
 * flows for a script), the complete answer from the server when the browser
 * holds only part of it, a view made from it, and a copy kept in this
 * browser — with what it found, so it can be exported or compared later.
 *
 * It says what each file holds BEFORE the click: a walk still landing makes
 * the actions wait; a walk paused at its memory checkpoint makes a file of
 * what was walked so far, and says so; chains this view cannot place are not
 * in the file, and that is said too.
 *
 * Portaled and anchored above the trigger, with no exit animation — the same
 * reasons `TraceSharePopover` gives.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Bookmark, BookmarkCheck, Download, FileJson, FileSpreadsheet, LayoutGrid, Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTraceEscStack } from './useTraceEscStack'
import { SavedTracesSection, type SavedTracesSectionProps } from './SavedTracesSection'

export interface TraceKeepActions {
  /** Rows a file would hold — the trace as the dock shows it. */
  rowCount: number
  /** The walk is still landing: the actions wait for it. */
  walking: boolean
  /** The walk stopped short (its memory checkpoint, a failed step): a file
   *  holds what was walked. */
  partial: boolean
  /** Chains the trace reached that this view cannot place — not in a file. */
  outsideView: number
  exportCsv: () => void
  exportJson: () => void
  /** The complete answer, resolved by the server. Absent: not offered. */
  exportEverything?: () => void
  /** A view made from the trace. Absent: not offered (no permission, or off). */
  saveAsView?: () => void
  /** This seed set is already saved in this browser. */
  saved: boolean
  /** Save it (again: refreshes the kept results). Resolves to what to tell
   *  the reader when the save is less than asked for. */
  save: () => Promise<string | null>
  savedList: SavedTracesSectionProps
}

export interface TraceKeepMenuProps extends TraceKeepActions {
  onClose: () => void
  triggerRef: React.RefObject<HTMLElement | null>
}

const item = cn(
  'w-full flex items-start gap-2.5 px-3.5 py-2 text-left transition-colors',
  'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
  'focus-visible:outline-none focus-visible:bg-black/[0.05] dark:focus-visible:bg-white/[0.08]',
  'disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-transparent',
)

export function TraceKeepMenu(props: TraceKeepMenuProps) {
  const {
    rowCount, walking, partial, outsideView, exportCsv, exportJson, exportEverything, saveAsView,
    saved, save, savedList, onClose, triggerRef,
  } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useTraceEscStack(true, onClose, 100)

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose, triggerRef])

  useEffect(() => { firstRef.current?.focus() }, [])

  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  useEffect(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 6 })
  }, [triggerRef])

  if (!anchor) return null
  const rows = `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`
  const holds = walking
    ? 'Waiting for the trace to finish landing…'
    : partial
      ? `What has been walked so far — ${rows}.`
      : `What the trace shows — ${rows}, open or not.`

  const doSave = async () => {
    setSaving(true)
    try {
      setNote(await save())
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <motion.div
      ref={panelRef}
      data-canvas-interactive
      role="dialog"
      aria-label="Export and save this trace"
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{ position: 'fixed', right: anchor.right, bottom: anchor.bottom, zIndex: 1000 }}
      className={cn(
        'w-[380px] max-w-[calc(100vw-16px)] rounded-xl overflow-hidden',
        'bg-canvas-elevated/98 backdrop-blur-2xl',
        'border border-glass-border shadow-glass-lg',
      )}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-glass-border/40">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <Download className="w-3 h-3" /> Export &amp; save
        </span>
        <p className="mt-1 text-[11px] text-ink-muted leading-snug" data-keep-holds>{holds}</p>
        {outsideView > 0 && !walking && (
          <p className="mt-0.5 text-[10.5px] text-ink-muted/80 leading-snug">
            {outsideView.toLocaleString()} {outsideView === 1 ? 'chain' : 'chains'} this view cannot place {outsideView === 1 ? 'is' : 'are'} not in the file.
          </p>
        )}
      </div>

      <div className="py-1">
        <button ref={firstRef} type="button" className={item} disabled={walking} onClick={() => { exportCsv(); onClose() }} data-keep="csv">
          <FileSpreadsheet className="w-4 h-4 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">CSV</span>
            <span className="block text-[10.5px] text-ink-muted">One row per entity — role, hops, layer, path, which seeds reach it</span>
          </span>
        </button>
        <button type="button" className={item} disabled={walking} onClick={() => { exportJson(); onClose() }} data-keep="json">
          <FileJson className="w-4 h-4 mt-0.5 text-sky-600 dark:text-sky-400 flex-shrink-0" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">JSON</span>
            <span className="block text-[10.5px] text-ink-muted">The entities and the flows between them, with the question that found them</span>
          </span>
        </button>
        {exportEverything && (
          <button type="button" className={item} onClick={() => { exportEverything(); onClose() }} data-keep="everything">
            <Network className="w-4 h-4 mt-0.5 text-violet-600 dark:text-violet-400 flex-shrink-0" />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">Everything it reaches…</span>
              <span className="block text-[10.5px] text-ink-muted">
                The complete trace, worked out on the server — inside this view or not, however large
              </span>
            </span>
          </button>
        )}
        {saveAsView && (
          <button type="button" className={item} disabled={walking} onClick={() => { saveAsView(); onClose() }} data-keep="view">
            <LayoutGrid className="w-4 h-4 mt-0.5 text-accent-lineage flex-shrink-0" />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">Save as view…</span>
              <span className="block text-[10.5px] text-ink-muted">A view of everything the trace reaches, kept up to date or frozen</span>
            </span>
          </button>
        )}
        <button type="button" className={item} disabled={walking || saving} onClick={() => { void doSave() }} data-keep="save">
          {saved
            ? <BookmarkCheck className="w-4 h-4 mt-0.5 text-accent-lineage flex-shrink-0" />
            : <Bookmark className="w-4 h-4 mt-0.5 text-ink-muted flex-shrink-0" />}
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-ink">
              {saving ? 'Saving…' : saved ? 'Saved ✓ — save again to refresh' : 'Save trace'}
            </span>
            <span className="block text-[10.5px] text-ink-muted">Kept in this browser, with what it found</span>
          </span>
        </button>
        {note && <p role="status" className="px-3.5 pb-1.5 text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug">{note}</p>}
      </div>

      <div className="border-t border-glass-border/40">
        <SavedTracesSection {...savedList} />
      </div>
    </motion.div>,
    document.body,
  )
}
