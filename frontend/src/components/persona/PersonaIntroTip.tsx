/**
 * PersonaIntroTip — once per browser, the Business view says what it is and
 * where the rest of the tools went. It points at the persona toggle, and goes
 * for good when dismissed, or once the persona is changed by any route (the
 * toggle, ⌘/, the command palette).
 *
 * It waits while a guided tour is running: the tour has its own spotlight on
 * this same toggle, and two cards pointing at one control say nothing twice.
 *
 * Portaled and fixed to the viewport, as SearchCoachmark is: the top bar is
 * its own stacking context. It unmounts at once, with no exit animation to
 * strand an invisible click-blocker.
 */
import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useHostRect } from '@/components/canvas/search/studio/useHostRect'
import { DocsLink } from '@/components/help/DocsLink'
import { Kbd } from '@/components/ui/Kbd'
import { useTourStore } from '@/features/tour/tourStore'
import { usePersonaStore } from '@/store/persona'

import { markPersonaIntroSeen, usePersonaIntroSeen } from './personaIntro'

const WIDTH = 320

export function PersonaIntroTip({ anchor }: {
    /** The persona toggle. */
    anchor: Element | null
}) {
    const seen = usePersonaIntroSeen()
    const mode = usePersonaStore((s) => s.mode)
    const setMode = usePersonaStore((s) => s.setMode)
    const touring = useTourStore((s) => s.activeTourId !== null)

    // Changing the persona, however it was done, is what the tip points at:
    // its work is done.
    const firstMode = useRef(mode)
    useEffect(() => {
        if (mode !== firstMode.current) markPersonaIntroSeen()
    }, [mode])

    const show = !seen && mode === 'business' && !touring
    const rect = useHostRect(show ? anchor : null)
    // A control hidden at this width has nothing to point from.
    if (!show || !rect || rect.width === 0) return null

    // Right-aligned under the toggle, which sits at the right of the top bar.
    const left = Math.max(8, rect.left + rect.width - WIDTH)
    const caret = Math.min(WIDTH - 20, Math.max(12, rect.left + rect.width / 2 - left - 6))
    return createPortal(
        <>
            <span aria-hidden className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-accent-business/50 motion-safe:animate-pulse"
                  style={{ top: rect.top - 2, left: rect.left - 2, width: rect.width + 4, height: rect.height + 4 }} />
            <div role="status" style={{ top: rect.top + rect.height + 10, left, width: WIDTH }}
                 className="fixed z-50 rounded-xl border border-accent-business/40 bg-canvas-elevated py-3 pl-3.5 pr-8 text-xs leading-snug text-ink shadow-xl shadow-black/30">
                <span className="font-semibold text-accent-business">New — a simpler Business view.</span>{' '}
                Menus and toolbars keep to the essentials, names read the way people say them, and an
                entity’s details open when you ask — <span className="font-medium">Details</span>, or
                Enter. Every other tool is one switch away: <span className="font-medium">Technical</span>,
                or press <Kbd shortcut="mod+/" />.
                <div className="mt-2.5 flex items-center gap-3">
                    <button type="button"
                            onClick={() => { markPersonaIntroSeen(); setMode('technical') }}
                            className="rounded-lg border border-accent-business/40 bg-accent-business/10 px-2.5 py-1 font-medium text-accent-business hover:bg-accent-business/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-business/40">
                        Show every tool
                    </button>
                    <DocsLink slug="key-concepts" newTab label="Business or Technical?" className="text-xs" />
                </div>
                <button type="button" onClick={markPersonaIntroSeen} aria-label="Got it"
                        className="absolute right-1.5 top-1.5 rounded-md p-1 text-ink-muted hover:bg-black/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-business/40 dark:hover:bg-white/[0.06]">
                    <X className="h-3.5 w-3.5" />
                </button>
                <span aria-hidden style={{ left: caret }}
                      className="absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t border-accent-business/40 bg-canvas-elevated" />
            </div>
        </>,
        document.body,
    )
}
