/**
 * HeaderFindField — the Context View's search box.
 *
 * The field itself stays deliberately plain: an icon, your text, a clear
 * button, and a way into Advanced Search. Everything that shapes the query —
 * how to match, which fields to look in — lives in the results panel below,
 * next to the results it changes. Cramming a dropdown into the field made it
 * compete with the text you were typing and left no room to say what it
 * meant.
 *
 * The panel is PORTALED TO THE BODY and positioned with `fixed` coordinates,
 * for the reason `ui/HoverTip` documents: this header sits inside
 * `overflow-hidden` flex containers, so an absolutely positioned dropdown is
 * clipped away by its own ancestor. It renders, occupies no visible space,
 * and reads as "the search is broken".
 *
 * See `useFindInView` for the two tiers behind it and `FindResultsPanel` for
 * the surface.
 */
import { AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { FindInViewState } from '@/hooks/useFindInView'
import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'
import type { AncestorRef } from '@/types/search'

import type { CanvasRoot } from '../../search/panel/groupHitsByTopLevel'
import { FindResultsPanel } from './FindResultsPanel'


const PANEL_MAX_WIDTH = 544
const GAP = 8
const EDGE = 8


export interface HeaderFindFieldProps {
    find: FindInViewState
    viewId: string
    viewName?: string
    onReveal: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    /** The canvas's top-level nodes, by URN. Passed straight through to
     *  the panel, which groups results under them. */
    canvasRoots: ReadonlyMap<string, CanvasRoot>
    /** Scroll the canvas to a result group's top-level node. */
    onRevealRoot?: (root: CanvasRoot) => void
    onFrame?: () => void
    /** Hand the compiled query to the Advanced Search rail. */
    onOpenAdvancedSearch?: (seed?: { text: string }) => void
}


export function HeaderFindField({
    find, viewId, viewName, canvasRoots,
    onReveal, onOpen, onRevealRoot, onFrame, onOpenAdvancedSearch,
}: HeaderFindFieldProps) {
    const inputRef = useRef<HTMLInputElement>(null)
    const fieldRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [panelOpen, setPanelOpen] = useState(false)

    const hasQuery = find.text.trim().length > 0
    const { box, place } = useAnchorBox(fieldRef, panelOpen)

    // Measure BEFORE opening, in the same batch. The field is already laid
    // out when any of these fire, so the panel lands in the right place on
    // its first paint — no frame at the origin, and no dependence on a
    // requestAnimationFrame that a test environment never flushes.
    const openPanel = useCallback(() => {
        place()
        setPanelOpen(true)
    }, [place])

    // ⌘F / Ctrl+F focuses the field, and "/" does too when the user isn't
    // already typing somewhere. Scoped to this component's lifetime, so they
    // only bind while a Context View is mounted.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            const typing = !!t && (
                t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                || t.tagName === 'SELECT' || t.isContentEditable
            )
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
                e.preventDefault()
                inputRef.current?.focus()
                inputRef.current?.select()
                openPanel()
                return
            }
            if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                inputRef.current?.focus()
                openPanel()
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [openPanel])

    // Escape, layered, at the window in CAPTURE phase.
    //
    // It cannot live on the input alone. The results panel is a
    // `role="dialog"`, and the canvas's trace-exit handler deliberately
    // yields the first Escape to any open dialog — "close this" before "take
    // the whole trace down". A panel that claims that press without consuming
    // it swallows Escape entirely, leaving a user unable to leave a trace
    // whenever focus isn't in the field.
    useEffect(() => {
        if (!panelOpen && !hasQuery) return
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            // One layer per press; the query goes last, because losing a
            // query you are still refining is the more expensive mistake.
            if (panelOpen) setPanelOpen(false)
            else find.clear()
        }
        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
    }, [panelOpen, hasQuery, find])

    // Click-away. The panel is portaled, so it is NOT inside the field's
    // subtree — testing only the field would close the panel on its own
    // scope chips and Load-more button.
    useEffect(() => {
        if (!panelOpen) return
        const onPointerDown = (e: MouseEvent) => {
            const t = e.target as Node
            if (fieldRef.current?.contains(t)) return
            if (panelRef.current?.contains(t)) return
            setPanelOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
    }, [panelOpen])

    const escalate = useCallback(() => {
        const text = find.text.trim()
        onOpenAdvancedSearch?.(text ? { text } : undefined)
        setPanelOpen(false)
    }, [find, onOpenAdvancedSearch])

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) { escalate(); return }
        if (!panelOpen) { openPanel(); return }
        // Panel already open: Enter walks the matches on the canvas, so a
        // second press does something rather than nothing.
        useSearchStore.getState().stepFocus(e.shiftKey ? 'prev' : 'next')
    }

    return (
        <div data-tour="canvas-search" className="justify-self-center w-full max-w-md">
            <div ref={fieldRef} className="relative group">
                {/* Accent halo on focus — soft glow behind the input that
                    lifts it off the header gradient. Pure decoration; sits
                    behind the input via negative inset. */}
                <div
                    aria-hidden
                    className={cn(
                        "absolute -inset-px rounded-[14px] pointer-events-none",
                        "bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0",
                        "group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15",
                        "group-focus-within:blur-[8px]",
                        "transition-all duration-300",
                    )}
                />
                <LucideIcons.Search
                    className={cn(
                        "absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] pointer-events-none",
                        "text-ink-muted/55 group-focus-within:text-accent-lineage",
                        "group-hover:text-ink-muted/80",
                        "transition-colors duration-200",
                    )}
                    strokeWidth={2.2}
                />
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="Find anything in this view…"
                    value={find.text}
                    onChange={(e) => { find.setText(e.target.value); openPanel() }}
                    onFocus={() => openPanel()}
                    onKeyDown={onKeyDown}
                    aria-label="Find entities anywhere in this view by name, description, tag or property"
                    aria-expanded={panelOpen}
                    className={cn(
                        "relative w-full pl-10 pr-20 py-2.5 rounded-[13px]",
                        "text-[13.5px] text-ink placeholder:text-ink-muted/45",
                        // Layered fill: subtle gradient + glass border so the
                        // field reads like a deliberate component, not a
                        // default text input.
                        "bg-gradient-to-b from-black/[0.03] to-black/[0.05]",
                        "dark:from-white/[0.04] dark:to-white/[0.025]",
                        "border border-black/[0.08] dark:border-white/[0.08]",
                        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                        "hover:border-black/[0.14] dark:hover:border-white/[0.14]",
                        "focus:outline-none",
                        "focus:border-accent-lineage/55 focus:ring-2 focus:ring-accent-lineage/20",
                        "focus:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]",
                        "focus:bg-gradient-to-b focus:from-black/[0.045] focus:to-black/[0.06]",
                        "dark:focus:from-white/[0.06] dark:focus:to-white/[0.045]",
                        "transition-all duration-200",
                    )}
                />

                {/* Clear, then the way into Advanced Search. The latter is
                    always visible: it used to be the only route out of this
                    box, and burying it in a panel you have to open first made
                    the rail unreachable for anyone who didn't. */}
                <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {hasQuery && (
                        <button
                            onClick={() => { find.clear(); inputRef.current?.focus() }}
                            aria-label="Clear search"
                            className={cn(
                                "p-1 rounded-md transition-all",
                                "text-ink-muted/70 hover:text-ink",
                                "hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
                            )}
                        >
                            <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} />
                        </button>
                    )}
                    {onOpenAdvancedSearch && (
                        <button
                            onClick={escalate}
                            aria-label={hasQuery
                                ? `Open "${find.text.trim()}" in Advanced Search`
                                : 'Open Advanced Search'}
                            title="Advanced Search — combine filters, save, share · ⌘⇧F"
                            className={cn(
                                'inline-flex items-center justify-center w-7 h-7 rounded-lg',
                                'transition-all duration-200 text-accent-lineage',
                                'bg-gradient-to-br from-accent-lineage/15 to-purple-500/10',
                                'border border-accent-lineage/30',
                                'hover:from-accent-lineage/25 hover:to-purple-500/20',
                                'hover:border-accent-lineage/55 hover:shadow-md hover:shadow-accent-lineage/20',
                                'active:scale-95',
                            )}
                        >
                            <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
                        </button>
                    )}
                </div>
            </div>

            {createPortal(
                <AnimatePresence>
                    {panelOpen && (
                        <FindResultsPanel
                            ref={panelRef}
                            state={find}
                            viewId={viewId}
                            viewName={viewName}
                            style={box
                                ? {
                                    position: 'fixed',
                                    left: box.left,
                                    top: box.top,
                                    width: box.width,
                                    maxHeight: box.maxHeight,
                                }
                                // Unmeasurable (a detached field in a test
                                // environment): render it rather than
                                // swallowing the panel entirely.
                                : { position: 'fixed', left: EDGE, top: EDGE }}
                            onReveal={(urn, path) => { onReveal(urn, path); setPanelOpen(false) }}
                            onOpen={onOpen}
                            canvasRoots={canvasRoots}
                            onRevealRoot={(root) => {
                                onRevealRoot?.(root)
                                setPanelOpen(false)
                            }}
                            onFrame={onFrame}
                            onEscalate={escalate}
                        />
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </div>
    )
}


interface AnchorBox { left: number; top: number; width: number; maxHeight: number }

/**
 * Track the field's viewport rect while the panel is open, so a `fixed`
 * portal can sit under it.
 *
 * Measurement runs in a `requestAnimationFrame` rather than the effect body:
 * the element has to be laid out first, and setState straight from an effect
 * is the cascading-render pattern the repo's lint rule rejects.
 */
function useAnchorBox(
    ref: React.RefObject<HTMLElement | null>,
    active: boolean,
): { box: AnchorBox | null; place: () => void } {
    const [box, setBox] = useState<AnchorBox | null>(null)

    const place = useCallback(() => {
        const el = ref.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const w = Math.min(PANEL_MAX_WIDTH, window.innerWidth - EDGE * 2)
        const ideal = r.left + r.width / 2 - w / 2
        setBox({
            left: Math.min(Math.max(ideal, EDGE), window.innerWidth - EDGE - w),
            top: r.bottom + GAP,
            width: w,
            // Never taller than the room actually left below the field.
            maxHeight: Math.max(200, window.innerHeight - r.bottom - GAP - EDGE),
        })
    }, [ref])

    useEffect(() => {
        if (!active) return
        // Capture phase: the canvas scrolls in nested containers, and a
        // popover that stays put while its trigger moves is worse than one
        // that never opened.
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
        }
    }, [active, place])

    return { box: active ? box : null, place }
}
