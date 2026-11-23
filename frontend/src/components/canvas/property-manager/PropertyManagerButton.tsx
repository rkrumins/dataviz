/**
 * PropertyManagerButton — the shared "Properties" toolbar trigger for the
 * Property Manager, used identically across all canvases.
 *
 * Premium discoverability: on first encounter (per browser, tracked in
 * localStorage) the button shows a one-time pulsing accent ring + a small
 * "New" coachmark so business users notice the capability. The hint
 * dismisses when the user opens the manager or clicks "Got it", and never
 * returns.
 *
 * The coachmark portals to the body and is fixed to the viewport. The
 * canvas headers that host this button carry `backdrop-blur`, which makes
 * a stacking context: rendered as an absolutely positioned child, the
 * coachmark's z-index only competed inside the header, and the canvas
 * body below painted over everything past the header band — users saw a
 * permanent 15 px strip peeking under the button and could never read or
 * close it.
 */
import { SlidersHorizontal, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import { Z_INDEX } from '@/lib/zIndex'
import { HoverTip } from '@/components/ui/HoverTip'
import { usePersonaIntroSeen } from '@/components/persona/personaIntro'
import { useTourStore } from '@/features/tour/tourStore'
import { usePersonaMode } from '@/store/persona'
import { useCurrentBranchId, useGraphId } from '@/store/branchStore'
import { jobEnded, useDraftPropertyJobs } from '@/store/propertyJobsStore'


export const PROPERTY_MANAGER_SEEN_KEY = 'synodic.propertyManager.seen.v1'

function readSeen(): boolean {
    try { return localStorage.getItem(PROPERTY_MANAGER_SEEN_KEY) === '1' } catch { return true }
}
function markSeen(): void {
    try { localStorage.setItem(PROPERTY_MANAGER_SEEN_KEY, '1') } catch { /* non-fatal */ }
}

// A tick that advances on every resize, on any scroll (capture) and when a
// surface makes part of the page inert, so the coachmark's placement — and
// whether its trigger is covered — is re-derived from the live page.
let viewportTick = 0
function subscribeViewport(onChange: () => void): () => void {
    const bump = () => { viewportTick += 1; onChange() }
    window.addEventListener('resize', bump)
    window.addEventListener('scroll', bump, true)
    const inert = typeof MutationObserver === 'function' ? new MutationObserver(bump) : null
    inert?.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true })
    return () => {
        window.removeEventListener('resize', bump)
        window.removeEventListener('scroll', bump, true)
        inert?.disconnect()
    }
}
const getViewportTick = () => viewportTick
// Once the hint is gone for good there is nothing to place: subscribe to
// nothing, so the button stops re-rendering on every scroll in the app.
const subscribeNothing = () => () => {}


export interface PropertyManagerButtonProps {
    open: boolean
    onToggle: () => void
    className?: string
    /** Its icon alone — a toolbar short of room (the Context View header's). */
    folded?: boolean
}


export function PropertyManagerButton({ open, onToggle, className, folded = false }: PropertyManagerButtonProps) {
    // The hint is armed once per browser; it shows whenever the manager is
    // closed until the user opens the manager or dismisses it.
    const [hintArmed, setHintArmed] = useState(() => !readSeen())
    // One first-run card at a time. The Business view's own intro opens beside
    // this button on a first visit; shown together, the two cards overlapped
    // each other and the toolbar's buttons. This one waits its turn, and for
    // any guided tour (as `SetupCoachMark` does).
    const personaIntroSeen = usePersonaIntroSeen()
    const persona = usePersonaMode()
    const personaIntroShowing = !personaIntroSeen && persona === 'business'
    const touring = useTourStore((s) => s.activeTourId !== null)
    const hintVisible = hintArmed && !open && !personaIntroShowing && !touring

    // Callback ref: the trigger element lands in state on mount, and the
    // coachmark's position is derived from its rect at render time —
    // re-derived when the viewport ticks. No state is written in effects.
    const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null)
    useSyncExternalStore(hintArmed ? subscribeViewport : subscribeNothing, getViewportTick, getViewportTick) // re-render on resize/scroll while the hint can show
    // Under an inert surface (the canvas, while Search Studio covers it) the
    // trigger can't be reached, and a coachmark fixed over the page would
    // float on top of that surface.
    const covered = !!triggerEl?.closest('[inert]')
    const rect = hintVisible && triggerEl && !covered ? triggerEl.getBoundingClientRect() : null
    const anchor = rect ? { top: rect.bottom + 8, left: rect.left } : null

    const dismissHint = () => { setHintArmed(false); markSeen() }
    // A bulk change being applied to the draft: the button says so while the manager is closed.
    const running = useDraftPropertyJobs(useGraphId(), useCurrentBranchId()).filter((j) => !jobEnded(j)).length

    const handleClick = () => {
        if (hintVisible) dismissHint()
        onToggle()
    }

    return (
        <div className="relative">
            <HoverTip
                className="inline-flex"
                label={running ? `${running === 1 ? 'A property change is' : `${running} property changes are`} being applied to your draft`
                    : 'Browse the properties in use, change them in bulk, and tag the entities that match'}
                detail={running ? 'Open to follow it — or stop it' : 'Display rules colour the canvas — the data is untouched'}
            >
            <button
                ref={setTriggerEl}
                onClick={handleClick}
                data-toolbar-item="properties"
                className={cn(
                    'relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition duration-300',
                    open
                        ? 'bg-gradient-to-r from-accent-lineage/30 to-purple-500/20 text-accent-lineage border border-accent-lineage/60 shadow-md shadow-accent-lineage/20'
                        /* A PLAIN token, not `bg-canvas-elevated/95`: the
                           canvas colours are complete CSS variables, so an
                           alpha suffix on one emits NO rule at all and this
                           was the only transparent button on a row where every
                           sibling paints a real fill. */
                        : 'bg-canvas-elevated/95 backdrop-blur border border-glass-border text-ink-muted hover:text-ink hover:border-accent-lineage/40',
                    folded && 'px-2.5',
                    className,
                )}
            >
                {/* First-run pulse ring */}
                {hintVisible && (
                    <span className="absolute -inset-0.5 rounded-xl ring-2 ring-accent-lineage/50 animate-pulse pointer-events-none" />
                )}
                <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
                <span data-toolbar-label className={folded ? 'sr-only' : undefined}>Properties</span>
                {running > 0 && (
                    <span aria-hidden className="absolute -top-1 -right-1 flex h-3 w-3">
                        <span className="absolute inset-0 rounded-full bg-accent-lineage/60 animate-ping" />
                        <span className="relative h-3 w-3 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
                    </span>
                )}
            </button>
            </HoverTip>

            {/* First-run coachmark — portaled so no header stacking context
                or overflow can clip it. No AnimatePresence/exit: it unmounts
                instantly, so it can never strand an invisible click-blocker. */}
            {anchor && typeof document !== 'undefined' && createPortal(
                <div
                    role="status"
                    style={{ position: 'fixed', top: anchor.top, left: anchor.left, zIndex: Z_INDEX.coach }}
                    className={cn(
                        'w-64 pl-3 pr-8 py-2 rounded-xl',
                        'bg-canvas-elevated border border-accent-lineage/40 shadow-xl shadow-black/30',
                        'text-[11px] text-ink leading-snug',
                    )}
                >
                    <span className="font-semibold text-accent-lineage">New — Property Manager.</span>{' '}
                    Browse properties in use and tag matched entities with colored display rules.
                    <button
                        type="button"
                        onClick={dismissHint}
                        aria-label="Got it"
                        className="absolute top-1.5 right-1.5 p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                    <span className="absolute -top-1.5 left-5 w-3 h-3 rotate-45 bg-canvas-elevated border-l border-t border-accent-lineage/40" />
                </div>,
                document.body,
            )}
        </div>
    )
}
