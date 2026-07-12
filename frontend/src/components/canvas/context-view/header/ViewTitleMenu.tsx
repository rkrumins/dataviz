/**
 * ViewTitleMenu — the Context View header's title block.
 *
 * Absorbs the whole title cluster (network icon, view name, and the subline
 * with its blueprint-sync spinner / retry affordance) and layers on the
 * view-metadata affordances, gated by VIEW-level rights — deliberately
 * independent of canvas Edit mode (view metadata is not graph data):
 *
 *   - A subtle chevron appears ONLY when the user has ≥1 capability
 *     (`canEditView || canShareView`). With none, the title stays a plain
 *     label — no chevron, no hover cue, no rename (the calm-view principle).
 *   - The chevron opens a small popover (styled like header/DisplayMenu):
 *     "Edit details…" (`canEditView`), "Share…" (`canShareView`), and a
 *     read-only visibility row when `viewVisibility` is known.
 *   - Double-click the title (when `canEditView`) swaps it to an input
 *     (LayerHierarchyPanel's input-swap precedent — no contentEditable);
 *     Enter/blur commits a trimmed, changed, non-empty name; Escape cancels.
 *
 * Store-free: props + callbacks only. The parent owns dialogs, API calls,
 * and capability derivation (see the canvas wiring).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export type ViewVisibility = 'private' | 'workspace' | 'enterprise'

export interface ViewTitleMenuProps {
  viewName: string
  /** Pre-composed subline ("{N} types · {model name}"). */
  subline: string
  canEditView: boolean
  canShareView: boolean
  viewVisibility?: ViewVisibility
  onRenameView?: (name: string) => void
  onEditViewDetails?: () => void
  onShareView?: () => void
  // Blueprint sync — surfaces only as a tiny subline spinner ('saving') or a
  // "Sync issue — retry" text button ('error' → onRetrySync).
  syncStatus: 'idle' | 'dirty' | 'saving' | 'synced' | 'error'
  onRetrySync?: () => void
}

const POPOVER_WIDTH = 260

// Plain-language visibility copy — short label on the row, the full sentence
// in `title` so the badge stays calm but the meaning is a hover away.
const VISIBILITY: Record<ViewVisibility, { label: string; hint: string; Icon: LucideIcons.LucideIcon }> = {
  private: {
    label: 'Private',
    hint: 'Private — only people it’s shared with',
    Icon: LucideIcons.Lock,
  },
  workspace: {
    label: 'Workspace',
    hint: 'Workspace — everyone in this workspace',
    Icon: LucideIcons.Building2,
  },
  enterprise: {
    label: 'Enterprise',
    hint: 'Enterprise — the whole organisation',
    Icon: LucideIcons.Globe,
  },
}

export function ViewTitleMenu({
  viewName,
  subline,
  canEditView,
  canShareView,
  viewVisibility,
  onRenameView,
  onEditViewDetails,
  onShareView,
  syncStatus,
  onRetrySync,
}: ViewTitleMenuProps) {
  const hasMenu = canEditView || canShareView

  const [isRenaming, setIsRenaming] = useState(false)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ top: rect.bottom + 8, left: rect.left })
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
      const target = e.target as Node
      const insideTrigger = triggerRef.current?.contains(target) ?? false
      const insidePopover = popoverRef.current?.contains(target) ?? false
      if (!insideTrigger && !insidePopover) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const runItem = (fn?: () => void) => {
    setOpen(false)
    fn?.()
  }

  const visibility = viewVisibility ? VISIBILITY[viewVisibility] : null

  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage/20 to-purple-500/20 flex items-center justify-center shadow-lg shadow-accent-lineage/10">
        <LucideIcons.Network className="w-5 h-5 text-accent-lineage" />
      </div>

      <div className="min-w-0">
        {/* Title row — name (or rename input) + capability chevron. `group`
            so the low-contrast chevron lifts to full presence on hover. */}
        <div className="group flex items-center gap-1 min-w-0">
          {isRenaming ? (
            <RenameInput
              defaultValue={viewName}
              onCommit={name => {
                setIsRenaming(false)
                onRenameView?.(name)
              }}
              onCancel={() => setIsRenaming(false)}
            />
          ) : (
            <h2
              className="text-base font-display font-semibold text-ink tracking-tight truncate"
              title={canEditView ? 'Double-click to rename' : viewName}
              onDoubleClick={canEditView ? () => setIsRenaming(true) : undefined}
            >
              {viewName}
            </h2>
          )}

          {hasMenu && !isRenaming && (
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="View options"
              className={cn(
                'flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-md text-ink-muted/50 transition-all duration-200',
                'opacity-60 group-hover:opacity-100 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
                open && 'opacity-100 text-ink bg-black/[0.05] dark:bg-white/[0.06]',
              )}
            >
              <LucideIcons.ChevronDown
                className={cn('w-3.5 h-3.5 transition-transform duration-200', open && 'rotate-180')}
              />
            </button>
          )}
        </div>

        <p className="text-[10px] text-ink-muted/70 flex items-center gap-1.5 min-w-0">
          <LucideIcons.ArrowRight className="w-3 h-3 flex-shrink-0" />
          <span className="truncate" title={subline}>{subline}</span>
          {syncStatus === 'saving' && (
            <LucideIcons.Loader2
              className="w-3 h-3 animate-spin flex-shrink-0"
              aria-label="Saving changes"
            />
          )}
          {syncStatus === 'error' && onRetrySync && (
            <button
              onClick={onRetrySync}
              className="flex-shrink-0 font-semibold text-amber-600 dark:text-amber-400 hover:underline underline-offset-2 transition-colors"
            >
              Sync issue — retry
            </button>
          )}
        </p>
      </div>

      {/* Portal escapes the header's backdrop-filter stacking context so the
          popover layers above the canvas body (see DisplayMenu). */}
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
              aria-label="View options"
              style={{
                position: 'fixed',
                top: anchor.top,
                left: anchor.left,
                width: POPOVER_WIDTH,
                zIndex: 1000,
              }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden py-1.5"
            >
              {canEditView && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runItem(onEditViewDetails)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-ink hover:bg-accent-lineage/[0.08] dark:hover:bg-accent-lineage/[0.12] transition-colors"
                >
                  <LucideIcons.PenLine className="w-4 h-4 text-ink-muted flex-shrink-0" strokeWidth={2} />
                  Edit details…
                </button>
              )}

              {canShareView && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runItem(onShareView)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-ink hover:bg-accent-lineage/[0.08] dark:hover:bg-accent-lineage/[0.12] transition-colors"
                >
                  <LucideIcons.Share2 className="w-4 h-4 text-ink-muted flex-shrink-0" strokeWidth={2} />
                  Share…
                </button>
              )}

              {visibility && (
                <>
                  <div className="h-px bg-black/[0.06] dark:bg-white/[0.05] mx-3 my-1" />
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-ink-muted/80"
                    title={visibility.hint}
                  >
                    <visibility.Icon className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} />
                    <span className="font-medium text-ink-muted">{visibility.label}</span>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}

/**
 * Input-swap rename field (LayerHierarchyPanel precedent — no contentEditable).
 * Holds its own draft so each rename session starts from the current name;
 * commits a trimmed, non-empty, changed value on Enter/blur, cancels on Escape.
 */
function RenameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(defaultValue)

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== defaultValue) onCommit(trimmed)
    else onCancel()
  }

  return (
    <input
      autoFocus
      value={value}
      aria-label="View name"
      onFocus={e => e.target.select()}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
        e.stopPropagation()
      }}
      onBlur={commit}
      className={cn(
        'min-w-0 bg-transparent border-b border-accent-lineage/60 outline-none',
        'text-base font-display font-semibold text-ink tracking-tight py-0',
      )}
    />
  )
}
