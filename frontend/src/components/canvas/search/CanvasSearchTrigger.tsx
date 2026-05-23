/**
 * Floating "Advanced Search" trigger for canvases that don't have a
 * dedicated header (GraphCanvas, HierarchyCanvas).
 *
 * ContextViewCanvas uses ContextViewHeader's onOpenAdvancedSearch button
 * instead — this trigger is for canvases without an integrated header.
 *
 * Binds the Cmd+K / Ctrl+K shortcut so search opens consistently across
 * every canvas.
 */
import { useEffect } from 'react'
import { Search } from 'lucide-react'

import { cn } from '@/lib/utils'


export interface CanvasSearchTriggerProps {
    open: boolean
    onToggle: () => void
    /** When true, the floating button is hidden — useful when another
     *  surface (e.g. EntityDrawer) is open and the trigger would clutter
     *  the corner. The keyboard shortcut still works. */
    hideButton?: boolean
}

export function CanvasSearchTrigger({
    open, onToggle, hideButton = false,
}: CanvasSearchTriggerProps) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Cmd+K on macOS, Ctrl+K elsewhere — matches the convention
            // already documented in the brief.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                onToggle()
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onToggle])

    if (hideButton) return null

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-label="Open advanced search (⌘K)"
            title="Advanced search · ⌘K"
            className={cn(
                'absolute top-4 right-4 z-30',
                'flex items-center gap-2 px-3 h-9 rounded-full',
                'bg-surface-elevated border border-border-subtle shadow-sm',
                'text-2xs font-medium text-ink-secondary',
                'hover:bg-surface-elevated-hover hover:text-ink',
                'transition-colors',
                open && 'bg-accent-subtle border-accent text-accent-strong',
            )}
        >
            <Search size={13} />
            <span>Search</span>
            <kbd className="ml-1 px-1.5 py-0.5 rounded text-2xs font-mono bg-surface-base/60 border border-border-subtle text-ink-muted">
                ⌘K
            </kbd>
        </button>
    )
}
