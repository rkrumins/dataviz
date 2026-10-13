/**
 * The explorer's search: the field people reach for first, so it is the
 * widest and the most helpful thing on the bar.
 *
 * Empty and focused, it offers what to look for: the searches made here
 * before (kept in this browser only), and words this range can answer — the
 * reasons people gave, the sources and targets acted on most. It searches as
 * you type; Enter or a pick searches at once. Over a range longer than search
 * reads, it says so and offers the range it will.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, CornerDownLeft, History, Loader2, Search, Sparkles, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/Kbd'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useTypewriter } from '@/hooks/useTypewriter'

import { useDebouncedCommit, useSuggestions } from './useSuggestions'

export const ACTIVITY_RECENTS_KEY = 'nexus.activity.recentSearches'

const PHRASES = [
    'a reason someone gave — “quarter-end”…',
    'a data source, a group or a view…',
    'an action — “member_added”, “refresh”…',
    'anything a change recorded…',
]

type Pick = { kind: 'recent' | 'range'; text: string }

export function ActivitySearchField({ value, onCommit, suggestions, disabled, maxDays, onFitRange, busy }: {
    value: string
    onCommit: (value: string) => void
    /** Words this range can answer, most useful first. */
    suggestions: string[]
    /** The range is longer than search reads. */
    disabled: boolean
    maxDays: number
    /** Switch to the longest range search reads. */
    onFitRange: () => void
    /** A search is on its way. */
    busy?: boolean
}) {
    const { recents, record, clear } = useRecentSearches(ACTIVITY_RECENTS_KEY)
    const [focused, setFocused] = useState(false)
    // Esc puts the list away until the field is used again.
    const [dismissed, setDismissed] = useState(false)

    const commit = (next: string) => {
        onCommit(next.trim())
        if (next.trim()) record(next)
    }
    const [text, setText, flush] = useDebouncedCommit(value, commit)

    const picks = useMemo<Pick[]>(() => {
        const seen = new Set<string>()
        const out: Pick[] = []
        for (const r of recents) {
            if (!seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); out.push({ kind: 'recent', text: r }) }
        }
        for (const s of suggestions) {
            if (out.length >= 9) break
            if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push({ kind: 'range', text: s }) }
        }
        return out
    }, [recents, suggestions])

    // "Search the last 90 days" lands in the field, ready to type, once the
    // range it asked for has arrived.
    const input = useRef<HTMLInputElement>(null)
    const focusWhenOpen = useRef(false)
    useEffect(() => {
        if (!disabled && focusWhenOpen.current) {
            focusWhenOpen.current = false
            input.current?.focus()
        }
    }, [disabled])

    const open = focused && !dismissed && !text && !disabled && picks.length > 0
    const pick = (p: Pick) => flush(p.text)
    const list = useSuggestions({ items: picks, open, onPick: pick })
    const { textRef, caretRef } = useTypewriter({ phrases: PHRASES, enabled: !focused && !text && !disabled })

    const group = (kind: Pick['kind']) => picks.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === kind)

    return (
        <div className="relative">
            <div className={cn(
                'relative flex h-11 items-center gap-1 rounded-xl border bg-canvas-elevated pr-2 transition-[border-color,box-shadow] duration-200',
                disabled
                    ? 'border-dashed border-glass-border'
                    : focused
                        ? 'border-accent-lineage/50 ring-4 ring-accent-lineage/10'
                        : 'border-glass-border hover:border-accent-lineage/30',
            )}>
                <Search aria-hidden className={cn(
                    'ml-3.5 h-4 w-4 shrink-0 transition-colors duration-150',
                    focused ? 'text-accent-lineage' : 'text-ink-muted',
                )} />
                <div className="relative min-w-0 flex-1">
                    <input
                        ref={input}
                        type="search"
                        data-activity-search=""
                        aria-label="Search activity"
                        {...list.inputProps}
                        value={text}
                        disabled={disabled}
                        placeholder={disabled
                            ? `Search reads at most ${maxDays} days at a time`
                            : focused ? 'Search what happened…' : ''}
                        title={disabled ? `Text search reads every event in its window, so it covers at most ${maxDays} days. Pick a shorter range to search.` : undefined}
                        onChange={(e) => { setText(e.target.value); setDismissed(false); list.reset() }}
                        onFocus={() => { setFocused(true); setDismissed(false); list.reset() }}
                        onBlur={() => setFocused(false)}
                        onKeyDown={(e) => {
                            if (list.onKeyDown(e)) return
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                flush(text)
                            } else if (e.key === 'Escape') {
                                if (open) setDismissed(true)
                                else e.currentTarget.blur()
                            }
                        }}
                        className="w-full bg-transparent px-2.5 py-2 text-sm font-medium text-ink outline-none placeholder:font-normal placeholder:text-ink-muted disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
                    />
                    {/* The animated prompt: painted over the empty field, never typed into it. */}
                    {!focused && !text && !disabled && (
                        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap px-2.5 text-sm text-ink-muted">
                            <span>Search&nbsp;</span>
                            <span ref={textRef} />
                            <span
                                ref={caretRef}
                                className="typewriter-caret-blink ml-[2px] inline-block h-[1.1em] w-[2px] translate-y-[1px] rounded-[1px] bg-accent-lineage/70"
                            />
                        </div>
                    )}
                </div>

                {busy && !!text && (
                    <Loader2 aria-label="Searching" className="h-4 w-4 shrink-0 animate-spin text-accent-lineage" />
                )}
                {!!text && (
                    <button
                        type="button"
                        aria-label="Clear the search"
                        // Cleared, the field stays the place to type next.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { flush(''); input.current?.focus() }}
                        className="shrink-0 rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.06]"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
                {disabled ? (
                    <button
                        type="button"
                        onClick={() => { focusWhenOpen.current = true; onFitRange() }}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-lineage/10 px-2.5 py-1 text-[11px] font-semibold text-accent-lineage transition-colors hover:bg-accent-lineage/15"
                    >
                        <CalendarRange className="h-3.5 w-3.5" aria-hidden />
                        Search the last 90 days
                    </button>
                ) : text && focused ? (
                    <span aria-hidden className="hidden shrink-0 items-center gap-1 text-[10px] text-ink-muted sm:inline-flex">
                        <CornerDownLeft className="h-3 w-3" /> to search now
                    </span>
                ) : !text && !focused ? (
                    <Kbd shortcut="/" className="hidden shrink-0 sm:inline-flex" />
                ) : null}
            </div>

            {open && (
                <div
                    {...list.listProps}
                    aria-label="Search suggestions"
                    className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-1.5 shadow-xl"
                >
                    {group('recent').length > 0 && (
                        <div role="presentation">
                            <div role="presentation" className="flex items-center justify-between px-2 pb-1 pt-1.5">
                                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                                    <History className="h-3 w-3" aria-hidden /> Recent
                                </span>
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={clear}
                                    className="text-[10px] font-semibold text-ink-muted hover:text-ink"
                                >
                                    Clear
                                </button>
                            </div>
                            {group('recent').map(({ p, i }) => (
                                <div
                                    key={`r-${p.text}`}
                                    {...list.optionProps(i)}
                                    className={cn(
                                        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-ink',
                                        i === list.active && 'bg-accent-lineage/10',
                                    )}
                                >
                                    <History className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
                                    <span className="truncate">{p.text}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {group('range').length > 0 && (
                        <div role="presentation">
                            <p role="presentation" className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                                <Sparkles className="h-3 w-3" aria-hidden /> In this range
                            </p>
                            <div role="presentation" className="flex flex-wrap gap-1.5 px-1.5 pb-1.5">
                                {group('range').map(({ p, i }) => (
                                    <span
                                        key={`s-${p.text}`}
                                        {...list.optionProps(i)}
                                        className={cn(
                                            'max-w-full cursor-pointer truncate rounded-lg border px-2 py-1 text-[11px] text-ink transition-colors',
                                            i === list.active
                                                ? 'border-accent-lineage/40 bg-accent-lineage/10'
                                                : 'border-glass-border bg-black/[0.02] hover:border-accent-lineage/30 dark:bg-white/[0.03]',
                                        )}
                                    >
                                        {p.text}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
