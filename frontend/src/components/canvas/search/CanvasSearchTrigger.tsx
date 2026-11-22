/**
 * "Advanced Search" trigger for canvases without ContextView's header:
 * floating in the corner (GraphCanvas), or `inline` in a header row of
 * the canvas's own (HierarchyCanvas), where floating would cover it.
 *
 * ContextViewCanvas uses ContextViewHeader's onOpenAdvancedSearch button
 * instead — this trigger is for canvases without an integrated header.
 *
 * Binds the Cmd+Shift+F / Ctrl+Shift+F shortcut so search opens
 * consistently across every canvas.
 */
import { useEffect } from 'react'
import { Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'


export interface CanvasSearchTriggerProps {
    open: boolean
    onToggle: () => void
    /** When true, the floating button is hidden — useful when another
     *  surface (e.g. EntityDrawer) is open and the trigger would clutter
     *  the corner. The keyboard shortcut still works. */
    hideButton?: boolean
    /** In its parent's flow — a header row — rather than floating in the
     *  canvas's top-right corner. */
    inline?: boolean
}

export function CanvasSearchTrigger({
    open, onToggle, hideButton = false, inline = false,
}: CanvasSearchTriggerProps) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Cmd+Shift+F on macOS, Ctrl+Shift+F elsewhere — matches the
            // convention already documented in the brief.
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault()
                onToggle()
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onToggle])

    if (hideButton) return null

    // The tip's anchor takes the placement, so the tip points at the button wherever it floats.
    return (
        <HoverTip
            label={open ? 'Close Advanced Search' : 'Open Advanced Search'}
            detail="Find entities by name, type, property or relationship"
            className={cn('inline-flex', inline ? 'shrink-0' : 'absolute top-4 right-4 z-30')}
        >
            <button
                type="button"
                onClick={onToggle}
                aria-label="Open advanced search (⌘⇧F)"
                className={cn(
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
        </HoverTip>
    )
}
