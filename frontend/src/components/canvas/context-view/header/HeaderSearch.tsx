/**
 * HeaderFindField — the Context View's search box.
 *
 * This box used to advertise its own weakness: "Search visible
 * entities…", "Searching visible entities only", "N in visible", and a
 * link inviting you to go somewhere else for a real search. It matched
 * two fields with a substring test over whatever the browser had already
 * downloaded, which on a lazily-hydrated canvas is a small and arbitrary
 * slice of the view.
 *
 * It is now the front door of the same engine the Advanced Search rail
 * runs on. Type a word and it searches every entity in the view at any
 * depth; the results panel below carries the same rows, the same
 * stepper, and the same Highlight / Isolate / Exclude control the rail
 * has. See `useFindInView` for the two tiers behind it and
 * `FindResultsPanel` for the surface.
 *
 * The field itself owns two things: the text, and the match mode. Mode
 * lives here rather than in the panel because it changes what the words
 * you are typing MEAN — it belongs within reach of the cursor. Field
 * scope lives in the panel, because it filters results and needs room
 * for four labels.
 */
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
    FIND_MODE_LABELS,
    type FindMode,
} from '@/components/canvas/search/find/compileFind'
import type { FindInViewState } from '@/hooks/useFindInView'
import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'
import type { AncestorRef } from '@/types/search'

import { FindResultsPanel } from './FindResultsPanel'


const MODE_ORDER: FindMode[] = ['contains', 'startsWith', 'exact']

const MODE_HINTS: Record<FindMode, string> = {
    contains: 'Anywhere in the text',
    startsWith: 'From the beginning',
    exact: 'The whole value, nothing more',
}


export interface HeaderFindFieldProps {
    find: FindInViewState
    viewId: string
    viewName?: string
    onReveal: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    onFrame?: () => void
    /** Hand the compiled query to the Advanced Search rail. */
    onOpenAdvancedSearch?: (seed?: { text: string }) => void
}


export function HeaderFindField({
    find, viewId, viewName, onReveal, onOpen, onFrame, onOpenAdvancedSearch,
}: HeaderFindFieldProps) {
    const inputRef = useRef<HTMLInputElement>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const [panelOpen, setPanelOpen] = useState(false)
    const [modeMenuOpen, setModeMenuOpen] = useState(false)

    const hasQuery = find.text.trim().length > 0
    const showPanel = panelOpen && hasQuery

    // ⌘F / Ctrl+F focuses the field, and "/" does too when the user
    // isn't already typing somewhere. Both are scoped to this component's
    // lifetime, so they only bind while a Context View is mounted.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null
            const typing = !!target && (
                target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.tagName === 'SELECT'
                || target.isContentEditable
            )
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
                e.preventDefault()
                inputRef.current?.focus()
                inputRef.current?.select()
                setPanelOpen(true)
                return
            }
            if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                inputRef.current?.focus()
                setPanelOpen(true)
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    // Click-away closes the panel but keeps the query — the canvas is
    // still lit up, and reopening shouldn't cost a retype.
    useEffect(() => {
        if (!showPanel) return
        const onPointerDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setPanelOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
    }, [showPanel])

    const escalate = () => {
        const text = find.text.trim()
        onOpenAdvancedSearch?.(text ? { text } : undefined)
        setPanelOpen(false)
    }

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault()
            // First press dismisses the panel, second clears the search.
            // Losing a query you're still refining to a stray Escape is
            // the more expensive mistake.
            if (showPanel) setPanelOpen(false)
            else if (hasQuery) find.clear()
            return
        }
        if (e.key === 'Enter') {
            e.preventDefault()
            if (e.metaKey || e.ctrlKey) { escalate(); return }
            if (!showPanel && hasQuery) {
                // Find-next across the canvas once the panel is dismissed.
                useSearchStore.getState().stepFocus(e.shiftKey ? 'prev' : 'next')
                return
            }
            setPanelOpen(true)
        }
    }

    return (
        <div
            ref={rootRef}
            data-tour="canvas-search"
            className="justify-self-center w-full max-w-md relative"
        >
            <div className="relative group">
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
                    onChange={(e) => { find.setText(e.target.value); setPanelOpen(true) }}
                    onFocus={() => { if (hasQuery) setPanelOpen(true) }}
                    onKeyDown={onKeyDown}
                    aria-label="Find entities anywhere in this view by name, description, tag or property"
                    aria-expanded={showPanel}
                    className={cn(
                        "relative w-full pl-10 pr-36 py-2.5 rounded-[13px]",
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

                {/* Right cluster: clear (when typed), the match-mode menu,
                    and the ⌘F hint (when idle). */}
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

                    <ModeMenu
                        mode={find.mode}
                        onChange={find.setMode}
                        open={modeMenuOpen}
                        onOpenChange={setModeMenuOpen}
                    />

                    {!hasQuery && (
                        <span
                            aria-hidden
                            className={cn(
                                "hidden lg:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md",
                                "text-[10px] font-semibold text-ink-muted/60",
                                "bg-black/[0.04] dark:bg-white/[0.05]",
                                "border border-black/[0.06] dark:border-white/[0.06]",
                            )}
                        >
                            ⌘F
                        </span>
                    )}
                </div>
            </div>

            <AnimatePresence>
                {showPanel && (
                    <FindResultsPanel
                        state={find}
                        viewId={viewId}
                        viewName={viewName}
                        onReveal={(urn, path) => { onReveal(urn, path); setPanelOpen(false) }}
                        onOpen={onOpen}
                        onFrame={onFrame}
                        onEscalate={escalate}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}


/**
 * Contains / Starts with / Is exactly.
 *
 * A dropdown rather than three chips: it sits inside a crowded field,
 * and the chosen value has to stay readable at a glance because it
 * silently changes what every word in the box means.
 */
function ModeMenu({
    mode, onChange, open, onOpenChange,
}: {
    mode: FindMode
    onChange: (m: FindMode) => void
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onPointerDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) onOpenChange(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
    }, [open, onOpenChange])

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => onOpenChange(!open)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`Match mode: ${FIND_MODE_LABELS[mode]}`}
                className={cn(
                    'inline-flex items-center gap-1 pl-2 pr-1.5 py-1 rounded-lg',
                    'text-[11px] font-medium whitespace-nowrap',
                    'text-ink-muted hover:text-ink',
                    'bg-black/[0.04] dark:bg-white/[0.05]',
                    'border border-black/[0.07] dark:border-white/[0.07]',
                    'hover:border-accent-lineage/40 transition-colors',
                    open && 'border-accent-lineage/55 text-accent-lineage',
                )}
            >
                {FIND_MODE_LABELS[mode]}
                <LucideIcons.ChevronDown className="w-3 h-3" strokeWidth={2.6} />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        role="listbox"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.12 }}
                        className={cn(
                            'absolute right-0 top-full mt-1.5 z-[60] w-56 p-1',
                            'rounded-xl glass-panel shadow-xl',
                            'border border-black/[0.08] dark:border-white/[0.10]',
                        )}
                    >
                        {MODE_ORDER.map((m) => (
                            <button
                                key={m}
                                role="option"
                                aria-selected={mode === m}
                                onClick={() => { onChange(m); onOpenChange(false) }}
                                className={cn(
                                    'w-full text-left px-2.5 py-1.5 rounded-lg transition-colors',
                                    mode === m
                                        ? 'bg-accent-lineage/12 text-accent-lineage'
                                        : 'text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
                                )}
                            >
                                <div className="text-[12.5px] font-medium">
                                    {FIND_MODE_LABELS[m]}
                                </div>
                                <div className="text-[10.5px] text-ink-muted/75">
                                    {MODE_HINTS[m]}
                                </div>
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
