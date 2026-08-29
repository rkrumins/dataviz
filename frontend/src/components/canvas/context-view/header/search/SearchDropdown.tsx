/**
 * "Top matches" — the first tier of the view search.
 *
 * Ten rows under the box, with the path to each one on the canvas. It is
 * what the results panel used to do by opening itself on every first
 * result set: an answer the user did not ask to have a whole rail taken
 * over for. The panel is still there behind "See all" — this surface is
 * the ninety per cent of searches that end in "that one".
 *
 * It decides NOTHING. Which rows it holds, whether a run is in flight,
 * whether a zero is a real zero and which row is active are all worked
 * out in HeaderSearch, where the keyboard rules live; this file draws
 * them and calls back. That split is what makes the rules testable
 * without a portal and the surface testable without a session.
 *
 * PORTALLED AND FIXED. The header has a backdrop-filter, so it creates a
 * stacking context and a list rendered inline is layered under the
 * canvas. The anchor is re-measured on resize and on capture-phase
 * scroll, because the canvas scrolls under a header that does not.
 *
 * ENTRANCE ONLY — no `AnimatePresence`, no `exit`. An interrupted exit on
 * a portalled surface strands an invisible full-width click-blocker over
 * the toolbar; that has cost this app three separate click-freeze bugs
 * and `AnchoredMenu` and `DisplayMenu` are built the same way for the
 * same reason.
 *
 * The whole surface swallows `mousedown`: a click anywhere in it must not
 * take DOM focus off the input, because "focused" is half of the open
 * rule and the list would close under the pointer before the click
 * landed.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useLayoutEffect, useState, type FC, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import type { QuickQuery } from '@/components/canvas/search/session/quickPredicate'
import type { SearchHit } from '@/types/search'

import { TopMatchRow } from './TopMatchRow'
import { TOP_MATCHES, topMatches, whyLabel } from './dropdownModel'


/** The row ids the input's `aria-activedescendant` points at. Derived in
 *  one place so the box and the list cannot disagree about them. */
export function optionId(listId: string, index: number): string {
    return `${listId}-option-${index}`
}


/** Narrower than the box on a small screen would put the path on a
 *  second line, which is the one thing the row is for. */
const MIN_WIDTH = 560
/** Breathing room against the viewport's right edge and its bottom. */
const EDGE = 16


export interface SearchDropdownProps {
    /** The box to hang under. Measured, not rendered into. */
    anchorRef: RefObject<HTMLElement | null>
    /** The listbox's DOM id — the input's `aria-controls`. */
    listId: string
    /** What the box holds, verbatim. */
    text: string
    /** The query the rows answer — the *why* chip reads it. */
    quick: QuickQuery
    /** The rows to draw. May be the PREVIOUS run's while the next one is
     *  in flight; the caller decides when they stop being true. */
    rows: SearchHit[]
    activeIndex: number
    /** A run is in flight. */
    running: boolean
    /** The standing answer failed, with this message. */
    error: string | null
    /** The standing answer is a real zero for this text. */
    zero: boolean
    /** The whole match count — `totalCount ?? candidateCount`. */
    count: number | null
    /** Whether that count is a floor rather than a total. */
    plus: boolean
    /** What was searched in this view before, newest first. */
    recents: string[]
    /** Which layer column a hit badges under, in this view's layout. */
    layerOf: (hit: SearchHit) => string | null

    onActivate: (index: number) => void
    onPick: (hit: SearchHit) => void
    onCrumb: (hit: SearchHit, index: number) => void
    onRecent: (text: string) => void
    /** One of the zero-state chips — a patch on the quick query. */
    onNarrow: (patch: Partial<QuickQuery>) => void
    onSeeAll: () => void
    onRefine: () => void
    onRetry: () => void
}


export const SearchDropdown: FC<SearchDropdownProps> = ({
    anchorRef, listId, text, quick, rows, activeIndex, running, error, zero,
    count, plus, recents, layerOf,
    onActivate, onPick, onCrumb, onRecent, onNarrow, onSeeAll, onRefine, onRetry,
}) => {
    const [box, setBox] = useState<
        { top: number; left: number; width: number } | null
    >(null)

    useLayoutEffect(() => {
        const update = () => {
            const rect = anchorRef.current?.getBoundingClientRect()
            if (!rect) return
            const left = rect.left
            setBox({
                top: rect.bottom + 6,
                left,
                width: Math.min(
                    Math.max(rect.width, MIN_WIDTH),
                    Math.max(window.innerWidth - left - EDGE, MIN_WIDTH),
                ),
            })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [anchorRef])

    if (typeof document === 'undefined' || !box) return null

    // Capped here as well as by the caller: "ten rows" is this surface's
    // own promise, and a caller that forgets `topMatches` should not be
    // able to turn the header into a scrolling result panel.
    const shown = topMatches(rows, TOP_MATCHES)
    const trimmed = text.trim()
    const countLabel = count === null
        ? null
        : `${count.toLocaleString()}${plus ? '+' : ''}`

    const body = (() => {
        if (!trimmed) return <EmptyState recents={recents} onRecent={onRecent} />
        if (error) return <ErrorState message={error} onRetry={onRetry} />
        if (zero && shown.length === 0) {
            return <ZeroState text={trimmed} onNarrow={onNarrow} onRefine={onRefine} />
        }
        if (shown.length > 0) {
            return (
                <>
                    <div className="px-3 pt-2 pb-1.5 flex items-baseline gap-2">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/70">
                            {countLabel === null
                                ? 'Top matches'
                                : `Top matches · ${countLabel} in this view`}
                        </span>
                        <span className="ml-auto shrink-0 hidden sm:flex items-center gap-1 text-[9.5px] text-ink-muted/60">
                            <kbd className="kbd">↑↓</kbd>
                            <kbd className="kbd">↵</kbd> reveal
                            <kbd className="kbd">⌘↵</kbd> all
                            <kbd className="kbd">esc</kbd>
                        </span>
                    </div>

                    <div
                        role="listbox"
                        id={listId}
                        aria-label="Top matches"
                        data-testid="dropdown-rows"
                        className={cn(
                            'px-1.5 pb-1.5 flex flex-col gap-0.5',
                            'overflow-y-auto custom-scrollbar',
                            running && 'opacity-60',
                        )}
                    >
                        {shown.map((hit, i) => (
                            <TopMatchRow
                                key={hit.node.urn}
                                hit={hit}
                                id={optionId(listId, i)}
                                active={i === activeIndex}
                                query={quick.text}
                                why={whyLabel(hit, quick).label}
                                layer={layerOf(hit)}
                                onActivate={() => onActivate(i)}
                                onPick={() => onPick(hit)}
                                onCrumb={(_, index) => onCrumb(hit, index)}
                            />
                        ))}
                    </div>

                    <div className={cn(
                        'flex items-center gap-2 px-3 py-1.5',
                        'border-t border-black/[0.06] dark:border-white/[0.06]',
                    )}>
                        <FooterButton onClick={onSeeAll}>
                            See all{countLabel ? ` ${countLabel}` : ''} results →
                        </FooterButton>
                        <FooterButton onClick={onRefine} accent>
                            <LucideIcons.Sparkles className="w-3 h-3" strokeWidth={2.4} />
                            Refine
                        </FooterButton>
                    </div>
                </>
            )
        }
        if (trimmed.length === 1) {
            return (
                <Note>{`Keep typing — or press ↵ to search for "${trimmed}"`}</Note>
            )
        }
        if (running) return <Note>Searching…</Note>
        return <Note>{GUIDANCE}</Note>
    })()

    return createPortal(
        <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
            onMouseDown={(e) => e.preventDefault()}
            // The box's outside-click handler cannot use containment to
            // find this surface — it lives at the end of <body>. The
            // marker is how a click in the list is told from a click away.
            data-view-search-dropdown="true"
            style={{
                position: 'fixed',
                top: box.top,
                left: box.left,
                width: box.width,
                zIndex: 1000,
                maxHeight: `min(60vh, calc(100vh - ${box.top}px - ${EDGE}px))`,
            }}
            className={cn(
                'relative flex flex-col overflow-hidden',
                'rounded-xl bg-canvas-elevated/95 backdrop-blur-xl',
                'border border-black/[0.10] dark:border-white/[0.08]',
                'shadow-2xl shadow-black/20 dark:shadow-black/40',
            )}
        >
            {running && (
                <div
                    aria-hidden
                    data-testid="dropdown-running-bar"
                    className={cn(
                        'absolute inset-x-0 top-0 h-0.5 z-10',
                        // The banners' sweep, at a working pace: a
                        // translating gradient reads as "still going"
                        // without claiming a percentage nobody knows.
                        'bg-[linear-gradient(110deg,transparent_25%,rgba(99,102,241,0.9)_50%,transparent_75%)]',
                        'bg-[length:250%_100%] animate-[shimmer_1.2s_ease-in-out_infinite]',
                    )}
                />
            )}
            {body}
        </motion.div>,
        document.body,
    )
}


/** What the box actually looks at — the sentence that stops a user
 *  concluding the search only covers what is expanded on screen. */
const GUIDANCE =
    "Searches names, descriptions, tags and property values — every level,"
    + " even containers you haven't opened."


function Note({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted/80">
            {children}
        </div>
    )
}


function EmptyState({ recents, onRecent }: {
    recents: string[]
    onRecent: (text: string) => void
}) {
    return (
        <div className="py-2">
            {recents.length > 0 && (
                <>
                    <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/70">
                        Recent in this view
                    </div>
                    <div className="px-1.5 pb-1.5 flex flex-col">
                        {recents.map((r) => (
                            <button
                                key={r}
                                type="button"
                                tabIndex={-1}
                                onClick={() => onRecent(r)}
                                className={cn(
                                    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left',
                                    'text-[12.5px] text-ink-secondary',
                                    'hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-ink',
                                    'transition-colors',
                                )}
                            >
                                <LucideIcons.Clock
                                    className="w-3 h-3 shrink-0 text-ink-muted/60"
                                    strokeWidth={2.2}
                                />
                                <span className="truncate">{r}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            <div className={cn(
                'px-3 pt-1.5 text-[11px] leading-relaxed text-ink-muted/70',
                recents.length > 0 && 'border-t border-black/[0.06] dark:border-white/[0.06]',
            )}>
                {GUIDANCE}
            </div>
        </div>
    )
}


function ZeroState({ text, onNarrow, onRefine }: {
    text: string
    onNarrow: (patch: Partial<QuickQuery>) => void
    onRefine: () => void
}) {
    return (
        <div className="px-3 py-3">
            <p className="text-[12.5px] text-ink">
                {`Nothing in this view contains "${text}"`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Chip onClick={() => onNarrow({ match: 'prefix' })}>Starts with</Chip>
                <Chip onClick={() => onNarrow({ match: 'exact' })}>Is exactly</Chip>
                <Chip onClick={() => onNarrow({ lookIn: 'name' })}>Names only</Chip>
                <Chip onClick={onRefine} accent>
                    <LucideIcons.Sparkles className="w-3 h-3" strokeWidth={2.4} />
                    Refine
                </Chip>
            </div>
        </div>
    )
}


function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="px-3 py-3">
            <p className="text-[12px] text-rose-600 dark:text-rose-300">{message}</p>
            <div className="mt-2">
                <Chip onClick={onRetry}>
                    <LucideIcons.RotateCw className="w-3 h-3" strokeWidth={2.4} />
                    Retry
                </Chip>
            </div>
        </div>
    )
}


function Chip({ children, onClick, accent }: {
    children: React.ReactNode
    onClick: () => void
    accent?: boolean
}) {
    return (
        <button
            type="button"
            tabIndex={-1}
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-lg',
                'text-[11px] font-medium transition-colors',
                accent
                    ? 'text-accent-lineage bg-accent-lineage/10 border border-accent-lineage/30 hover:bg-accent-lineage/20'
                    : 'text-ink-secondary bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}


function FooterButton({ children, onClick, accent }: {
    children: React.ReactNode
    onClick: () => void
    accent?: boolean
}) {
    return (
        <button
            type="button"
            tabIndex={-1}
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-lg',
                'text-[11px] font-medium transition-colors',
                accent
                    ? 'ml-auto text-accent-lineage hover:bg-accent-lineage/10'
                    : 'text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
            )}
        >
            {children}
        </button>
    )
}
