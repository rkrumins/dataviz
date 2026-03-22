/**
 * ViewCardOverflowMenu — "..." overflow menu on view cards with
 * lifecycle actions: Delete, Change Visibility, Share.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { MoreHorizontal, Trash2, Share2, Globe, Users, Lock, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateViewVisibility } from '@/services/viewApiService'

interface ViewCardOverflowMenuProps {
  viewId: string
  viewName: string
  visibility: 'private' | 'workspace' | 'enterprise'
  onDelete: () => void
  onShare: () => void
  onVisibilityChange?: (visibility: 'private' | 'workspace' | 'enterprise') => void
}

export function ViewCardOverflowMenu({
  viewId,
  viewName: _viewName,
  visibility,
  onDelete,
  onShare,
  onVisibilityChange,
}: ViewCardOverflowMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [visibilitySubmenu, setVisibilitySubmenu] = useState(false)
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
      console.error('Failed to update visibility:', err)
    }
    setIsOpen(false)
    setVisibilitySubmenu(false)
  }, [viewId, onVisibilityChange])

  const VISIBILITY_OPTIONS = [
    { id: 'private' as const, label: 'Private', icon: Lock },
    { id: 'workspace' as const, label: 'Workspace', icon: Users },
    { id: 'enterprise' as const, label: 'Enterprise', icon: Globe },
  ]

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={e => { e.preventDefault(); e.stopPropagation(); setIsOpen(!isOpen) }}
        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-all opacity-0 group-hover:opacity-100"
      >
        <MoreHorizontal className="w-4 h-4 text-ink-muted" />
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute right-0 top-full mt-1 w-52 py-1 z-50',
            'bg-canvas/98 backdrop-blur-2xl rounded-2xl shadow-2xl',
            'border border-glass-border',
          )}
          onClick={e => { e.preventDefault(); e.stopPropagation() }}
        >
          {!visibilitySubmenu ? (
            <>
              <button
                onClick={() => { onShare(); setIsOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <Share2 className="w-3.5 h-3.5" />
                Share
              </button>
              <button
                onClick={() => setVisibilitySubmenu(true)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all rounded-xl mx-0.5"
                style={{ width: 'calc(100% - 4px)' }}
              >
                <Eye className="w-3.5 h-3.5" />
                Change Visibility
              </button>
              <div className="border-t border-glass-border/50 my-1" />
              <button
                onClick={() => { onDelete(); setIsOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-red-500 hover:bg-red-500/10 transition-all rounded-xl mx-0.5"
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
                    'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium transition-all rounded-xl mx-0.5',
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
                className="w-full px-3.5 py-2 text-xs font-medium text-ink-muted hover:text-ink transition-all"
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
