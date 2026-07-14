/**
 * ImportExportMenu — one compact header dropdown that replaces the two standalone Import / Export
 * buttons (space-saving). Rendered in BOTH view and edit modes so Export (a re-importable backup) is
 * always reachable; the Import item is disabled with an explainer when not in Edit mode, because
 * import targets the working draft and there is no branch to write to in a published View.
 *
 * Mirrors the header's portal-menu pattern (ViewTitleMenu / DisplayMenu): trigger + fixed-positioned
 * portal to document.body (escapes the header's backdrop-blur stacking context), outside-click/Escape
 * to close. Store-free — props + callbacks only.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'

export interface ImportExportMenuProps {
  onImport?: () => void
  onExport?: () => void
  /** Edit mode (a draft is open). Import requires it; Export does not. */
  isDraft: boolean
}

const POPOVER_WIDTH = 268

export function ImportExportMenu({ onImport, onExport, isDraft }: ImportExportMenuProps) {
  // Bulk import writes to a draft — pointless (and misleading) when the admin
  // has versioning off, so the item is hidden entirely.
  const versioningEnabled = useFeature('versioningEnabled')
  // Export is the door the DATA leaves by, and it now has its own switch. It used to have none:
  // an admin could turn off "Export layers" (the SCHEMA), watch the page go green, and the lineage
  // itself still walked out through here. Locking the shape of the estate while leaving the
  // contents open is the kind of gap that only looks safe.
  const exportEnabled = useFeature('graphExportEnabled')
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !popoverRef.current?.contains(t)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const runItem = (fn: () => void) => { setOpen(false); fn() }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Import / Export"
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11.5px] font-semibold tracking-tight transition-all',
          open
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm'
            : 'text-ink/85 border border-black/[0.10] dark:border-white/[0.08] bg-black/[0.03] dark:bg-white/[0.03] hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.06]',
        )}
      >
        <LucideIcons.ArrowDownUp className="w-3.5 h-3.5" strokeWidth={2.4} />
        <span>Import / Export</span>
        <LucideIcons.ChevronDown className={cn('w-3 h-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {/* No AnimatePresence: the popover unmounts instantly on close so an
          interrupted exit can never strand an invisible click-blocker at
          z-1000 over the toolbar. It still animates in. */}
      {typeof document !== 'undefined' && createPortal(
        <>
          {open && anchor && (
            <motion.div
              ref={popoverRef}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              role="menu"
              aria-label="Import and export"
              style={{ position: 'fixed', top: anchor.top, right: anchor.right, width: POPOVER_WIDTH, zIndex: 1000 }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden py-1.5"
            >
              {/* Import — needs Edit mode + a branch (import writes to the working draft). */}
              {versioningEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!isDraft || !onImport}
                  onClick={() => { if (isDraft && onImport) runItem(onImport) }}
                  title={isDraft ? undefined : 'Import needs Edit mode — start a branch first'}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
                    isDraft
                      ? 'text-ink hover:bg-accent-lineage/[0.08] dark:hover:bg-accent-lineage/[0.12]'
                      : 'text-ink-muted/50 cursor-not-allowed',
                  )}
                >
                  <LucideIcons.Upload className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">Import…</span>
                    <span className="block text-[11px] text-ink-muted/80 leading-snug">
                      {isDraft
                        ? 'Bring entities in from CSV, Excel or NDJSON.'
                        : 'Available in Edit mode — start a branch to import.'}
                    </span>
                  </span>
                </button>
              )}

              {/* Export — the door the DATA leaves by, and the server now refuses it when the
                  admin has turned it off. Hidden rather than disabled: a greyed-out control invites
                  people to hunt for the permission they think they're missing. */}
              {exportEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!onExport}
                  onClick={() => { if (onExport) runItem(onExport) }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left text-ink hover:bg-accent-lineage/[0.08] dark:hover:bg-accent-lineage/[0.12] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <LucideIcons.Download className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">Export…</span>
                    <span className="block text-[11px] text-ink-muted/80 leading-snug">
                      Download the graph — also a re-importable backup.
                    </span>
                  </span>
                </button>
              )}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}
