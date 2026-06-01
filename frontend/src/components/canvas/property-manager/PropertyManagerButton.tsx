/**
 * PropertyManagerButton — the shared "Properties" toolbar trigger for the
 * Property Manager, used identically across all canvases.
 *
 * Premium discoverability: on first encounter (per browser, tracked in
 * localStorage) the button shows a one-time pulsing accent ring + a small
 * "New" coachmark so business users notice the capability. The hint
 * dismisses the moment the user opens the manager, and never returns.
 */
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'


const SEEN_KEY = 'synodic.propertyManager.seen.v1'

function readSeen(): boolean {
    try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return true }
}
function markSeen(): void {
    try { localStorage.setItem(SEEN_KEY, '1') } catch { /* non-fatal */ }
}


export interface PropertyManagerButtonProps {
    open: boolean
    onToggle: () => void
    className?: string
}


export function PropertyManagerButton({ open, onToggle, className }: PropertyManagerButtonProps) {
    // Show the first-run hint only when never seen AND not already open.
    const [showHint, setShowHint] = useState(false)
    useEffect(() => {
        if (!readSeen() && !open) setShowHint(true)
    }, [open])

    const handleClick = () => {
        if (showHint) { setShowHint(false); markSeen() }
        onToggle()
    }

    return (
        <div className="relative">
            <button
                onClick={handleClick}
                title="Property Manager — browse properties and tag matched entities"
                className={cn(
                    'relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-all duration-300',
                    open
                        ? 'bg-gradient-to-r from-accent-lineage/30 to-purple-500/20 text-accent-lineage border border-accent-lineage/60 shadow-md shadow-accent-lineage/20'
                        : 'bg-canvas-elevated/95 backdrop-blur border border-glass-border text-ink-muted hover:text-ink hover:border-accent-lineage/40',
                    className,
                )}
            >
                {/* First-run pulse ring */}
                {showHint && (
                    <span className="absolute -inset-0.5 rounded-xl ring-2 ring-accent-lineage/50 animate-pulse pointer-events-none" />
                )}
                <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
                <span>Properties</span>
            </button>

            {/* First-run coachmark */}
            {showHint && (
                <div className={cn(
                    'absolute top-full left-0 mt-2 z-40 w-56 px-3 py-2 rounded-xl',
                    'bg-canvas-elevated border border-accent-lineage/40 shadow-xl shadow-black/30',
                    'text-[11px] text-ink leading-snug',
                )}>
                    <span className="font-semibold text-accent-lineage">New — Property Manager.</span>{' '}
                    Browse properties in use and tag matched entities with colored display rules.
                    <span className="absolute -top-1.5 left-5 w-3 h-3 rotate-45 bg-canvas-elevated border-l border-t border-accent-lineage/40" />
                </div>
            )}
        </div>
    )
}
