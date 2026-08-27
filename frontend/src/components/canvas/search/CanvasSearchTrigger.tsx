/**
 * Floating "Advanced Search" trigger for canvases that don't have a
 * dedicated header (GraphCanvas, HierarchyCanvas).
 *
 * ContextViewCanvas uses ContextViewHeader's onOpenAdvancedSearch button
 * instead — this trigger is for canvases without an integrated header.
 *
 * Binds Cmd+Shift+F / Ctrl+Shift+F so search opens consistently across
 * every canvas. NOT Cmd+K — that belongs to the app-wide command palette,
 * which binds it globally.
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
    // ⌘⇧F, not ⌘K. ⌘K belongs to the app-wide command palette, which binds
    // it globally; this used to bind it too, so on a canvas route one
    // press opened both surfaces at once. ⌘F focuses a canvas's own find
    // field where it has one, and ⌘⇧F opens the full search — the same
    // shape as find vs. find-and-replace everywhere else.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
            if (e.key.toLowerCase() !== 'f') return
            // Never steal the shortcut out from under someone typing.
            const t = e.target as HTMLElement | null
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                || t.tagName === 'SELECT' || t.isContentEditable)) return
            e.preventDefault()
            onToggle()
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onToggle])

    if (hideButton) return null

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-label="Open advanced search (⌘⇧F)"
            title="Advanced search · ⌘⇧F"
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
                ⌘⇧F
            </kbd>
        </button>
    )
}
