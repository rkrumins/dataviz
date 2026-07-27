/**
 * ViewCardOverflowMenu — "..." overflow menu on view cards with
 * lifecycle actions: Delete, Change Visibility, Share.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { MoreHorizontal, Pencil, Trash2, Share2, Eye, History, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateViewVisibility } from '@/services/viewApiService'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'
import { useToast } from '@/components/ui/toast'
import { VISIBILITY_META, VISIBILITY_ORDER } from '@/types/viewVisibility'
import type { ViewVisibility } from '@/types/viewVisibility'

interface ViewCardOverflowMenuProps {
  viewId: string
  viewName: string
  visibility: ViewVisibility
  onEdit?: () => void
  /** Opens the full builder (ViewWizard) — entity scope, layers, layout. */
  onEditLayout?: () => void
  editDisabled?: boolean
  onDelete: () => void
  onShare: () => void
  onVisibilityChange?: (visibility: ViewVisibility) => void
  /**
   * Mirrors view_access.can_change_visibility (creator OR workspace admin).
   * Defaults to true so existing callers are unchanged; ExplorerPage
   * computes it. Without this the tier submenu rendered for everyone and
   * only failed on save.
   */
  canChangeVisibility?: boolean
}

export function ViewCardOverflowMenu({
  viewId,
  viewName,
  visibility,
  onEdit,
  onEditLayout,
  editDisabled,
  onDelete,
  onShare,
  onVisibilityChange,
  canChangeVisibility = true,
}: ViewCardOverflowMenuProps) {
  const toast = useToast()
  const [isOpen, setIsOpen] = useState(false)
  const [visibilitySubmenu, setVisibilitySubmenu] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setVisibilitySubmenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const handleVisibilityChange = useCallback(async (newVisibility: typeof visibility) => {
    try {
      await updateViewVisibility(viewId, newVisibility)
      onVisibilityChange?.(newVisibility)
    } catch (err) {
      // Was console.error only — the menu closed and the card kept showing
      // the old tier, so a failed change looked like a successful one.
      console.error('Failed to update visibility:', err)
      toast.showToast(
        'error',
        err instanceof Error
          ? `Could not change visibility: ${err.message}`
          : 'Could not change visibility',
      )
    }
    setIsOpen(false)
    setVisibilitySubmenu(false)
  }, [viewId, onVisibilityChange, toast])

  const VISIBILITY_OPTIONS = VISIBILITY_ORDER.map(id => ({
    id,
    label: VISIBILITY_META[id].label,
    icon: VISIBILITY_META[id].icon as React.ElementType,
  }))

  return (
    <div ref={menuRef} className="relative">
      <ViewActivityDrawer
        viewId={activityOpen ? viewId : null}
        viewName={viewName}
        isOpen={activityOpen}
        onClose={() => setActivityOpen(false)}
      />
      <button
        onClick={e => { e.preventDefault(); e.stopPropagation(); setIsOpen(!isOpen) }}
        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
      >
        <MoreHorizontal className="w-4 h-4 text-ink-muted" />
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute right-0 top-full mt-1 w-52 py-1 z-50',
            'bg-white dark:bg-slate-900 rounded-2xl shadow-lg',
            'border border-glass-border',
          )}
          onClick={e => { e.preventDefault(); e.stopPropagation() }}
        >
          {!visibilitySubmenu ? (
            <>
              {onEdit && (
                editDisabled ? (
                  <span
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted/40 cursor-not-allowed rounded-xl mx-0.5"
                    style={{ width: 'calc(100% - 4px)' }}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="flex-1 text-left">Edit details</span>
                    <span className="text-[10px] text-ink-muted/50 font-normal">Switch workspace</span>
                  </span>
                ) : (
                  <button
                    onClick={() => { onEdit(); setIsOpen(false) }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                    style={{ width: 'calc(100% - 4px)' }}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="flex-1 text-left">Edit details</span>
                  </button>
                )
              )}
              {onEditLayout && (
                <button
                  onClick={() => { onEditLayout(); setIsOpen(false) }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                  style={{ width: 'calc(100% - 4px)' }}
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  Edit layout &amp; scope
                </button>
              )}
              <button
                onClick={() => { onShare(); setIsOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <Share2 className="w-3.5 h-3.5" />
                Share
              </button>
              {canChangeVisibility && (
                <button
                  onClick={() => setVisibilitySubmenu(true)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                  style={{ width: 'calc(100% - 4px)' }}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Change Visibility
                </button>
              )}
              <button
                onClick={() => { setActivityOpen(true); setIsOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <History className="w-3.5 h-3.5" />
                Activity
              </button>
              <div className="border-t border-glass-border/50 my-1" />
              <button
                onClick={() => { onDelete(); setIsOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-red-500 hover:bg-red-500/10 transition-colors duration-150 rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </>
          ) : (
            <>
              <div className="px-3.5 py-2 text-[10px] uppercase tracking-widest text-ink-muted font-bold">
                Visibility
              </div>
              {VISIBILITY_OPTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => handleVisibilityChange(id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 rounded-xl mx-0.5',
                    visibility === id
                      ? 'text-accent-lineage bg-accent-lineage/10'
                      : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5'
                  )}
                  style={{ width: 'calc(100% - 4px)' }}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                  {visibility === id && <span className="ml-auto text-[10px] font-bold uppercase tracking-wider">Current</span>}
                </button>
              ))}
              <div className="border-t border-glass-border/50 my-1" />
              <button
                onClick={() => setVisibilitySubmenu(false)}
                className="w-full px-3.5 py-2 text-xs font-medium text-ink-muted hover:text-ink transition-colors duration-150"
              >
                Back
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
