/**
 * SetupCoachMark — once per browser, the Business view points an editor at "Set up with a guide":
 * what it asks, and that nothing is saved before the review. Built as `PersonaIntroTip` is:
 * portaled and fixed to the viewport, it measures the button it points at as the page scrolls, and
 * unmounts at once, with no exit animation to strand an invisible click-blocker.
 *
 * Only in the Business view, and only where the button is (it is an editor's). It waits while a
 * guided tour runs, and until the Business view's own intro has been seen, so two cards never show
 * at once. It is done on "Got it", or once the guide opens by any route (`useSetupGuide`).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { useHostRect } from '@/components/canvas/search/studio/useHostRect'
import { DocsLink } from '@/components/help/DocsLink'
import { usePersonaIntroSeen } from '@/components/persona/personaIntro'
import { useTourStore } from '@/features/tour/tourStore'
import { usePersonaMode } from '@/store/persona'

import { markSetupIntroSeen, useSetupIntroSeen } from './setupIntro'

const WIDTH = 340
const GUTTER = 8

export function SetupCoachMark({ anchor }: {
    /** "Set up with a guide". */
    anchor: Element | null
}) {
    const seen = useSetupIntroSeen()
    const personaSeen = usePersonaIntroSeen()
    const mode = usePersonaMode()
    const touring = useTourStore((s) => s.activeTourId !== null)
    const show = !seen && personaSeen && mode === 'business' && !touring
    const rect = useHostRect(show ? anchor : null)
    const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth))
    useEffect(() => {
        if (!show) return
        const measure = () => setViewport(window.innerWidth)
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [show])
    // A button hidden at this width has nothing to point from.
    if (!show || !rect || rect.width === 0) return null

    // Under the button, from its left edge, kept on screen at a phone's width.
    const width = Math.min(WIDTH, viewport - GUTTER * 2)
    const left = Math.max(GUTTER, Math.min(rect.left, viewport - width - GUTTER))
    const caret = Math.min(width - 22, Math.max(14, rect.left + Math.min(rect.width / 2, 40) - left - 6))
    return createPortal(
        <>
            <span aria-hidden className="pointer-events-none fixed z-40 rounded-[14px] ring-2 ring-indigo-500/50 motion-safe:animate-pulse dark:ring-indigo-400/60"
                style={{ top: rect.top - 3, left: rect.left - 3, width: rect.width + 6, height: rect.height + 6 }} />
            <div role="status" style={{ top: rect.top + rect.height + 12, left, width }}
                className="fixed z-40 rounded-xl border border-indigo-500/40 bg-canvas-elevated p-3.5 text-[13px] leading-snug text-ink shadow-xl shadow-black/25 dark:border-indigo-400/40">
                <p className="font-semibold text-indigo-700 dark:text-indigo-300">New: set up with a guide.</p>
                <p className="mt-1 text-ink-secondary">
                    A few plain questions: what matters most, what people see while new data loads, memory, drafts and imports.
                    Then the usual review. Nothing is saved until you save it there.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button type="button" onClick={markSetupIntroSeen}
                        className="rounded-lg bg-indigo-600 px-3 py-1 text-[12.5px] font-semibold text-white outline-none hover:bg-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:ring-offset-1">
                        Got it
                    </button>
                    <DocsLink slug="governance-ops" newTab label="How the guide works" className="text-xs text-indigo-700 dark:text-indigo-300" />
                </div>
                <span aria-hidden style={{ left: caret }}
                    className="absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t border-indigo-500/40 bg-canvas-elevated dark:border-indigo-400/40" />
            </div>
        </>,
        document.body,
    )
}
