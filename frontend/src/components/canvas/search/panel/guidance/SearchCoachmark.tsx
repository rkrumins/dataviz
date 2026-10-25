/**
 * SearchCoachmark — a first-run tip pointing at Search Studio, once per
 * browser: what it is, how to open it, and the guide a click away. It goes
 * for good when dismissed, or once the Studio has been opened by any way
 * in (its button, E, the command palette).
 *
 * Portaled and fixed to the viewport, as the Property Manager's is: the
 * panel's blurred header makes a stacking context that would clip it. It
 * unmounts at once, with no exit to strand an invisible click-blocker.
 */
import { X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { DocsLink } from '@/components/help/DocsLink'
import { Kbd } from '@/components/ui/Kbd'
import { useSearchStore } from '@/store/searchStore'

import { useHostRect } from '../../studio/useHostRect'
import { markSearchIntroSeen, useSearchIntroSeen } from './searchIntro'


export function SearchCoachmark({ anchor }: {
    /** The control that opens Search Studio. */
    anchor: Element | null
}) {
    const seen = useSearchIntroSeen()
    const studioOpen = useSearchStore((s) => s.studioOpen)
    // Opening the Studio is what it points at: its work is done.
    useEffect(() => {
        if (studioOpen) markSearchIntroSeen()
    }, [studioOpen])
    const rect = useHostRect(seen || studioOpen ? null : anchor)
    // A control hidden at this width has nothing to point from.
    if (seen || studioOpen || !rect || rect.width === 0) return null

    const left = rect.left + rect.width / 2 - 20
    return createPortal(
        <>
            <span aria-hidden className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-accent-lineage/50 motion-safe:animate-pulse"
                  style={{ top: rect.top - 2, left: rect.left - 2, width: rect.width + 4, height: rect.height + 4 }} />
            <div role="status" style={{ top: rect.top + rect.height + 10, left }}
                 className="fixed z-50 w-72 rounded-xl border border-accent-lineage/40 bg-canvas-elevated py-2.5 pl-3 pr-8 text-xs leading-snug text-ink shadow-xl shadow-black/30">
                <span className="font-semibold text-accent-lineage">New — Search Studio.</span>{' '}
                Open this search out over the canvas: the query, a table of what it finds and what the view
                holds, side by side. Press <Kbd shortcut="e" /> from the panel any time.
                <div className="mt-2">
                    <DocsLink slug="advanced-search" newTab label="How search works" className="text-xs" />
                </div>
                <button type="button" onClick={markSearchIntroSeen} aria-label="Got it"
                        className="absolute right-1.5 top-1.5 rounded-md p-1 text-ink-muted hover:bg-black/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.06]">
                    <X className="h-3.5 w-3.5" />
                </button>
                <span aria-hidden className="absolute -top-1.5 left-4 h-3 w-3 rotate-45 border-l border-t border-accent-lineage/40 bg-canvas-elevated" />
            </div>
        </>,
        document.body,
    )
}
