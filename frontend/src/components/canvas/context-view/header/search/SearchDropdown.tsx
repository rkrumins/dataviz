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
import {
    useEffect, useLayoutEffect, useState,
    type FC, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import type { QuickQuery } from '@/components/canvas/search/session/quickPredicate'
import type { SearchHit } from '@/types/search'

import { TopMatchRow } from './TopMatchRow'
import { TOP_MATCHES, listboxKind, narrowingHints, topMatches, whyLabel } from './dropdownModel'


/** The row ids the input's `aria-activedescendant` points at. Derived in
 *  one place so the box and the list cannot disagree about them. */
export function optionId(listId: string, index: number): string {
    return `${listId}-option-${index}`
}


/** Narrower than the box on a small screen would put the path on a
 *  second line, which is the one thing the row is for. */
const MIN_WIDTH = 560
/** Breathing room against the viewport's bottom. */
const EDGE = 16
/** ...and against either side. The 560 floor is worth keeping on a narrow
 *  window — it is what puts the path on one line — so the surface slides
 *  left to stay on screen rather than shrinking below it. */
const SIDE = 8


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
    /** Whether `rows` still answer the box as it now stands. Rows that do
     *  not are dimmed, and they lose to the one-character hint: a box
     *  holding one letter has no standing answer worth showing. */
    stale: boolean
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
    count, plus, recents, stale, layerOf,
    onActivate, onPick, onCrumb, onRecent, onNarrow, onSeeAll, onRefine, onRetry,
}) => {
    const [box, setBox] = useState<
        { top: number; left: number; width: number } | null
    >(null)

    useLayoutEffect(() => {
        const update = () => {
            const rect = anchorRef.current?.getBoundingClientRect()
            if (!rect) return
            const width = Math.max(rect.width, MIN_WIDTH)
            setBox({
                top: rect.bottom + 6,
                // Flush with the box's left edge, unless that would hang
                // the right edge off the window.
                left: Math.max(SIDE, Math.min(rect.left, window.innerWidth - width - SIDE)),
                width,
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

    // The list scrolls inside its own 60vh box, so ten rows can outrun it
    // and the highlight is the only thing saying what ↵ will do. Looked up
    // by id rather than by selector: `useId` produces ids containing ':',
    // which is not a valid selector without escaping.
    //
    // `box` is a dependency because it is null on the first render — the
    // anchor is measured in a layout effect — so the options do not exist
    // in the DOM yet on the pass that opens the list.
    useEffect(() => {
        document.getElementById(optionId(listId, activeIndex))
            ?.scrollIntoView({ block: 'nearest' })
    }, [listId, activeIndex, rows, box])

    if (typeof document === 'undefined' || !box) return null

    // Capped here as well as by the caller: "ten rows" is this surface's
    // own promise, and a caller that forgets `topMatches` should not be
    // able to turn the header into a scrolling result panel.
    const shown = topMatches(rows, TOP_MATCHES)
    const trimmed = text.trim()
    const countLabel = count === null
        ? null
        : `${count.toLocaleString()}${plus ? '+' : ''}`
    const hints = narrowingHints(count, quick)

    // Rows that no longer answer the box are still worth showing — the
    // alternative is a list that blinks out on every keystroke — but they
    // are drawn as what they are.
    const dimmed = stale || running
    const oneChar = trimmed.length === 1

    // Whether there is a listbox, and which — decided once, by the same
    // function the box derives its `aria-expanded` and `aria-controls`
    // from. When each worked it out for itself they came apart on the
    // states neither had in mind, and the box named elements this surface
    // had not rendered.
    const kind = listboxKind({
        rows: shown.length,
        recents: recents.length,
        error: error !== null,
        oneChar,
        stale,
        textEmpty: trimmed === '',
    })

    const body = (() => {
        if (kind === 'recents') {
            return (
                <RecentsList
                    listId={listId}
                    recents={recents}
                    activeIndex={activeIndex}
                    onActivate={onActivate}
                    onRecent={onRecent}
                />
            )
        }
        if (kind !== 'rows') {
            // No list. What stands in its place — a card, a line — is a
            // separate question, and none of these answers may put one
            // back: `kind` has already told the box there is none.
            if (trimmed === '') return <Note>{GUIDANCE}</Note>
            if (error) return <ErrorState message={error} onRetry={onRetry} />
            if (zero) {
                return <ZeroState text={trimmed} onNarrow={onNarrow} onRefine={onRefine} />
            }
            if (oneChar) {
                return <Note>{`Keep typing — or press ↵ to search for "${trimmed}"`}</Note>
            }
            if (running) return <Note>Searching…</Note>
            return <Note>{GUIDANCE}</Note>
        }
        return (
            <>
                <div
                    data-testid="dropdown-header"
                    className={cn(
                        'px-3 pt-2 pb-1.5 flex items-baseline gap-2',
                        dimmed && 'opacity-60',
                    )}
                >
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

                {hints.length > 0 && (
                    <div className="px-3 pb-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10.5px] text-ink-muted/70">
                            Many matches — narrow:
                        </span>
                        {hints.map((hint) => (
                            <Chip key={hint.label} onClick={() => onNarrow(hint.patch)}>
                                {hint.label}
                            </Chip>
                        ))}
                    </div>
                )}

                <div
                    role="listbox"
                    id={listId}
                    aria-label="Top matches"
                    data-testid="dropdown-rows"
                    className={cn(
                        'px-1.5 pb-1.5 flex flex-col gap-0.5',
                        'overflow-y-auto custom-scrollbar',
                        dimmed && 'opacity-60',
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
                'rounded-xl bg-canvas-elevated backdrop-blur-xl',
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


function Note({ children }: { children: ReactNode }) {
    return (
        <div className="px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted/80">
            {children}
        </div>
    )
}


/**
 * The empty box: what was searched here before, and what searching here
 * covers.
 *
 * The recents are REAL options — same `role`, same listbox, same id
 * scheme as the hit rows — so ↑/↓ and ↵ work on them without the box
 * needing a second keyboard mode, and its `aria-controls` points at one
 * element whichever state is up. With no recents `listboxKind` says
 * 'none' and this is never rendered: the guidance line is prose, not a
 * choice, and a combobox that claimed an empty popup would send a screen
 * reader looking for one.
 */
function RecentsList({ listId, recents, activeIndex, onActivate, onRecent }: {
    listId: string
    recents: string[]
    activeIndex: number
    onActivate: (index: number) => void
    onRecent: (text: string) => void
}) {
    return (
        <div className="py-2">
            <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/70">
                Recent in this view
            </div>
                    <div
                        role="listbox"
                        id={listId}
                        aria-label="Recent searches"
                        className="px-1.5 pb-1.5 flex flex-col"
                    >
                        {recents.map((r, i) => (
                            <div
                                key={r}
                                id={optionId(listId, i)}
                                role="option"
                                aria-selected={i === activeIndex}
                                onMouseEnter={() => onActivate(i)}
                                onClick={() => onRecent(r)}
                                className={cn(
                                    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer',
                                    'text-[12.5px] transition-colors',
                                    i === activeIndex
                                        ? 'bg-accent-lineage/10 text-ink'
                                        : 'text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-ink',
                                )}
                            >
                                <LucideIcons.Clock
                                    className="w-3 h-3 shrink-0 text-ink-muted/60"
                                    strokeWidth={2.2}
                                />
                                <span className="truncate">{r}</span>
                            </div>
                ))}
            </div>
            <div className={cn(
                'px-3 pt-1.5 text-[11px] leading-relaxed text-ink-muted/70',
                'border-t border-black/[0.06] dark:border-white/[0.06]',
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
    children: ReactNode
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
    children: ReactNode
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
