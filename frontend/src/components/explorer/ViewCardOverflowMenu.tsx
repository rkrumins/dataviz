/**
 * ViewCardOverflowMenu — "..." overflow menu on view cards with
 * lifecycle actions: Delete, Change Visibility, Share.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  MoreHorizontal, Pencil, Trash2, Share2, Eye, History, Settings2, Loader2,
} from 'lucide-react'
import {
  buildVisibilityOptions, visibilityDescription, VISIBILITY_ACCENT,
} from '@/lib/viewVisibility'
import { usePublishGate } from '@/hooks/usePublishGate'
import { useBrand } from '@/store/branding'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { updateViewVisibility } from '@/services/viewApiService'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'

interface ViewCardOverflowMenuProps {
  viewId: string
  viewName: string
  visibility: 'private' | 'workspace' | 'enterprise'
  /** Needed to resolve the publish gate — an open workspace lets members
   *  publish directly, a restricted source does not. */
  workspaceId?: string
  dataSourceId?: string
  onEdit?: () => void
  /** Opens the full builder (ViewWizard) — entity scope, layers, layout. */
  onEditLayout?: () => void
  editDisabled?: boolean
  onDelete: () => void
  onShare: () => void
  onVisibilityChange?: (visibility: 'private' | 'workspace' | 'enterprise') => void
}

export function ViewCardOverflowMenu({
  viewId,
  viewName,
  visibility,
  workspaceId,
  dataSourceId,
  onEdit,
  onEditLayout,
  editDisabled,
  onDelete,
  onShare,
  onVisibilityChange,
}: ViewCardOverflowMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [visibilitySubmenu, setVisibilitySubmenu] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const { showToast } = useToast()
  const { appName } = useBrand()
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
    if (newVisibility === visibility) { setIsOpen(false); setVisibilitySubmenu(false); return }
    setSaving(newVisibility)
    try {
      await updateViewVisibility(viewId, newVisibility)
      // Say WHAT changed, not that something did. "Updated" leaves the
      // reader checking the card to find out what they just agreed to —
      // and until the parent wired this callback, the card still showed
      // the old tier, so there was nothing to check against.
      showToast(
        'success',
        `"${viewName}" — ${visibilityDescription(newVisibility, { appName })
          .replace(/^Only you/, 'only you')}`,
      )
      onVisibilityChange?.(newVisibility)
    } catch (err) {
      // A silent console.error left the menu claiming success on a 403.
      const detail = err instanceof Error ? err.message : 'Failed to update visibility'
      showToast(
        'error',
        detail.includes('workspace:view:publish')
          ? 'Publishing to everyone needs approval — open Share to ask.'
          : detail,
      )
    } finally {
      setSaving(null)
    }
    setIsOpen(false)
    setVisibilitySubmenu(false)
  }, [viewId, viewName, visibility, appName, onVisibilityChange, showToast])

  // The same ladder every other surface resolves — permission, workspace
  // policy, restricted source, platform ceiling — so a tier this person
  // cannot set is never offered as a plain click that 403s.
  const gate = usePublishGate(workspaceId, dataSourceId)
  const VISIBILITY_OPTIONS = buildVisibilityOptions({
    saved: visibility,
    canPublish: gate.canPublish,
    canRequestPublish: gate.canRequestPublish,
    restrictedSource: gate.restrictedSource,
    blockedBy: gate.blockedBy,
    enterpriseAvailable: gate.enterpriseAvailable,
    appName,
  })

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
            'absolute right-0 top-full mt-1 py-1 z-50',
            visibilitySubmenu ? 'w-72' : 'w-52',
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
              <button
                onClick={() => setVisibilitySubmenu(true)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <Eye className="w-3.5 h-3.5" />
                Change Visibility
              </button>
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
              <div className="px-3.5 pt-2 pb-1">
                <p className="text-[10px] uppercase tracking-widest text-ink-muted font-bold">
                  Who can open this view
                </p>
                <p className="text-[10px] text-ink-muted/70 leading-snug mt-0.5">
                  Takes effect immediately. You can change it back at any time.
                </p>
              </div>
              {VISIBILITY_OPTIONS.map(({
                id, label, description, icon: Icon,
                disabled, disabledReason, requiresApproval, approvalHint,
              }) => {
                const isCurrent = visibility === id
                const accent = VISIBILITY_ACCENT[id]
                const busy = saving === id
                return (
                  <button
                    key={id}
                    // A tier that needs approval is NOT a menu click — it is
                    // a request with a note, which lives in the Share dialog
                    // beside the panel explaining what publishing exposes.
                    // Firing a doomed PUT from here would 403 and teach the
                    // user nothing.
                    onClick={() => {
                      if (disabled || busy) return
                      if (requiresApproval) { onShare(); setIsOpen(false); return }
                      void handleVisibilityChange(id)
                    }}
                    disabled={disabled || busy}
                    title={disabledReason ?? approvalHint}
                    className={cn(
                      'w-full flex items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-150 rounded-xl mx-0.5',
                      isCurrent
                        ? cn('bg-black/[0.03] dark:bg-white/[0.04]')
                        : 'hover:bg-black/5 dark:hover:bg-white/5',
                      disabled && 'opacity-45 cursor-not-allowed hover:bg-transparent',
                    )}
                    style={{ width: 'calc(100% - 4px)' }}
                  >
                    <Icon className={cn(
                      'w-3.5 h-3.5 mt-0.5 shrink-0',
                      isCurrent ? accent.iconText : 'text-ink-muted',
                    )} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn(
                          'text-sm font-semibold',
                          isCurrent ? 'text-ink' : 'text-ink-muted',
                        )}>
                          {label}
                        </span>
                        {isCurrent && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-ink-muted/70">
                            Current
                          </span>
                        )}
                        {requiresApproval && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                            Needs approval
                          </span>
                        )}
                        {busy && <Loader2 className="w-3 h-3 animate-spin text-ink-muted ml-auto" />}
                      </span>
                      {/* The tier NAME is the least informative thing about
                          it. This is the same sentence the wizard and the
                          Share dialog use — one source, so a person is never
                          told two different things about one tier. */}
                      <span className="block text-[11px] text-ink-muted/80 leading-snug mt-0.5">
                        {disabled && disabledReason
                          ? disabledReason
                          : requiresApproval && approvalHint
                            ? approvalHint
                            : description}
                      </span>
                    </span>
                  </button>
                )
              })}
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
