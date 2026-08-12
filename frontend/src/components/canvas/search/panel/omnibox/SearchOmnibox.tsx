/**
 * SearchOmnibox — the one place you start (or extend) a query.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ⌕  PII                                          ⏎ add │
 *   ├──────────────────────────────────────────────────────┤
 *   │ TAGS                                                 │
 *   │  #  Tagged #PII                                      │
 *   │ PROPERTY VALUES  · sampled from this data source     │
 *   │  ⚙  classification is PII                            │
 *   │ PROPERTIES                                           │
 *   │  ⚿  Has a pii_flag value                             │
 *   │ NAME & DESCRIPTION                                   │
 *   │  ⌕  Name contains "PII"                              │
 *   └──────────────────────────────────────────────────────┘
 *
 * Two ways in, one surface. Type and every facet the backend can query
 * is matched at once (``suggestFilters`` owns that ranking); or type
 * nothing and browse by facet with the tiles, which narrow this same
 * list rather than navigating somewhere else. Selecting an item appends
 * a real filter row to the draft and leaves focus in the input, so
 * filters chain without touching the mouse.
 *
 * Built on cmdk with ``shouldFilter={false}`` — the same arrangement
 * ``layout/CommandPalette`` uses. cmdk supplies the roving selection,
 * arrow/Home/End handling, scroll-into-view across groups, and the
 * combobox/listbox/option roles; we supply the ranking. That division
 * is deliberate: the hand-rolled alternative in this codebase
 * (``AddFilterPalette``) is 871 lines with no keyboard navigation at all.
 */
import { Command } from 'cmdk'
import { CornerDownLeft, Search, SlidersHorizontal, X } from 'lucide-react'
import { type FC, useCallback, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HighlightedText } from '@/components/ui/HighlightedText'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import type { LayerOption } from '../layerOptions'

import {
    BROWSE_FACETS,
    suggestFilters,
    type FilterSuggestion,
    type SuggestionGroup,
    type ValueSample,
} from './suggestFilters'


export interface SearchOmniboxProps {
    /** Add a filter row to the draft. ``complete`` is false when the
     *  predicate still wants a value, so the caller can focus the new
     *  row's editor. */
    onAdd: (predicate: Predicate, complete: boolean) => void
    /** Open the full filter taxonomy (AddFilterPalette) for the long
     *  tail this fast path deliberately doesn't carry. */
    onBrowseAll?: () => void
    entityTypes: ReadonlyArray<string>
    tagValues: ReadonlyArray<string>
    propertyKeys: ReadonlyArray<string>
    valueSamples: ReadonlyArray<ValueSample>
    layers: ReadonlyArray<LayerOption>
    /** ``hero`` is the empty-query front door: bigger, autofocused,
     *  always-open list. ``inline`` is the compact add-another-filter
     *  bar that sits under existing rows and only opens on focus. */
    variant?: 'hero' | 'inline'
    /** Prefill (used when the user escalates from the canvas header's
     *  quick search with text already typed). */
    initialQuery?: string
    discoveryLoading?: boolean
    disabled?: boolean
}


export const SearchOmnibox: FC<SearchOmniboxProps> = ({
    onAdd, onBrowseAll, entityTypes, tagValues, propertyKeys,
    valueSamples, layers, variant = 'hero', initialQuery = '',
    discoveryLoading = false, disabled = false,
}) => {
    const [query, setQuery] = useState(initialQuery)
    const [activeGroup, setActiveGroup] = useState<SuggestionGroup | null>(null)
    const [focused, setFocused] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    const sections = useMemo(() => suggestFilters({
        query, entityTypes, tagValues, propertyKeys, valueSamples,
        layers, activeGroup,
    }), [query, entityTypes, tagValues, propertyKeys, valueSamples, layers, activeGroup])

    const handleSelect = useCallback((item: FilterSuggestion) => {
        onAdd(item.predicate, item.complete)
        setQuery('')
        setActiveGroup(null)
        // Stay put — chaining two filters shouldn't cost a click.
        inputRef.current?.focus()
    }, [onAdd])

    // Escape unwinds one layer at a time: the facet filter, then the
    // typed text, then focus. Dismissing everything on the first press
    // throws away work the user can't get back.
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'Escape') return
        if (activeGroup) {
            e.preventDefault()
            e.stopPropagation()
            setActiveGroup(null)
        } else if (query) {
            e.preventDefault()
            e.stopPropagation()
            setQuery('')
        }
    }, [activeGroup, query])

    const isHero = variant === 'hero'
    const listOpen = isHero || focused || query.length > 0
    const itemCount = sections.reduce((n, s) => n + s.items.length, 0)

    return (
        <Command
            loop
            shouldFilter={false}
            onKeyDown={handleKeyDown}
            className={cn(
                'w-full rounded-xl overflow-hidden',
                'bg-canvas-elevated/70 border border-glass-border',
                'focus-within:border-accent-lineage/60',
                'focus-within:shadow-[0_0_0_3px_rgba(99,102,241,0.12)]',
                'transition-shadow duration-150',
            )}
        >
            <div className={cn(
                'flex items-center gap-2 px-3',
                isHero ? 'h-11' : 'h-9',
            )}>
                <Search className={cn(
                    'shrink-0 text-ink-muted',
                    isHero ? 'w-4 h-4' : 'w-3.5 h-3.5',
                )} />
                <Command.Input
                    ref={inputRef}
                    value={query}
                    onValueChange={setQuery}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    disabled={disabled}
                    autoFocus={isHero}
                    placeholder={activeGroup
                        ? `Filter ${labelFor(activeGroup)}…`
                        : isHero
                            ? 'Search by name, tag, type, property…'
                            : 'Add another filter…'}
                    className={cn(
                        'flex-1 min-w-0 bg-transparent text-ink',
                        'placeholder:text-ink-muted/60 focus:outline-none',
                        isHero ? 'text-[13.5px]' : 'text-[12.5px]',
                    )}
                />
                {activeGroup && (
                    <button
                        type="button"
                        onClick={() => { setActiveGroup(null); inputRef.current?.focus() }}
                        className={cn(
                            'shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md',
                            'bg-accent-lineage/15 text-accent-lineage text-[10.5px] font-medium',
                            'hover:bg-accent-lineage/25 transition-colors',
                        )}
                    >
                        {labelFor(activeGroup)}
                        <X className="w-3 h-3" />
                    </button>
                )}
                {itemCount > 0 && listOpen && (
                    <kbd className={cn(
                        'shrink-0 hidden sm:inline-flex items-center gap-1',
                        'text-[9.5px] text-ink-muted/70',
                    )}>
                        <CornerDownLeft className="w-3 h-3" /> add
                    </kbd>
                )}
            </div>

            {listOpen && (
                <>
                    {/* Facet tiles — the browse half of the surface. They
                        narrow the list below rather than navigating, so
                        typing and browsing never fight each other. */}
                    {!query && (
                        <div className={cn(
                            'flex flex-wrap gap-1 px-3 pb-2 pt-0.5',
                            'border-b border-glass-border/50',
                        )}>
                            {BROWSE_FACETS.map((facet) => (
                                <button
                                    key={facet.group}
                                    type="button"
                                    aria-pressed={activeGroup === facet.group}
                                    onClick={() => setActiveGroup(
                                        activeGroup === facet.group ? null : facet.group,
                                    )}
                                    className={cn(
                                        'inline-flex items-center gap-1 h-6 px-2 rounded-md',
                                        'text-[10.5px] font-medium transition-colors',
                                        activeGroup === facet.group
                                            ? 'bg-accent-lineage/20 text-accent-lineage'
                                            : 'bg-glass/40 text-ink-secondary hover:text-ink hover:bg-glass/70',
                                    )}
                                >
                                    <DynamicIcon name={facet.icon} className="w-3 h-3" />
                                    {facet.label}
                                </button>
                            ))}
                            {onBrowseAll && (
                                <button
                                    type="button"
                                    onClick={onBrowseAll}
                                    className={cn(
                                        'inline-flex items-center gap-1 h-6 px-2 rounded-md ml-auto',
                                        'text-[10.5px] font-medium',
                                        'text-ink-muted hover:text-ink hover:bg-glass/70',
                                        'transition-colors',
                                    )}
                                >
                                    <SlidersHorizontal className="w-3 h-3" />
                                    All filters
                                </button>
                            )}
                        </div>
                    )}

                    <Command.List className={cn(
                        'overflow-y-auto custom-scrollbar p-1.5',
                        isHero ? 'max-h-[320px]' : 'max-h-[260px]',
                    )}>
                        <Command.Empty className="py-6 px-3 text-center">
                            <p className="text-[12px] text-ink-muted">
                                {discoveryLoading
                                    ? 'Reading what\'s queryable in this view…'
                                    : `Nothing matches "${query}" yet.`}
                            </p>
                        </Command.Empty>

                        {sections.map((section) => (
                            <Command.Group
                                key={section.group}
                                heading={
                                    <span className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
                                        <span className={cn(
                                            'text-[9.5px] uppercase tracking-[0.12em]',
                                            'font-semibold text-ink-muted/70',
                                        )}>
                                            {section.heading}
                                        </span>
                                        {section.note && (
                                            <span className="text-[10px] text-ink-muted/60 normal-case tracking-normal leading-snug">
                                                {section.note}
                                            </span>
                                        )}
                                    </span>
                                }
                            >
                                {section.items.map((item) => (
                                    <Command.Item
                                        key={item.id}
                                        value={item.id}
                                        onSelect={() => handleSelect(item)}
                                        className={cn(
                                            'flex items-center gap-2.5 px-2 py-1.5 rounded-lg',
                                            'cursor-pointer select-none',
                                            'data-[selected=true]:bg-accent-lineage/12',
                                        )}
                                    >
                                        <span className={cn(
                                            'shrink-0 inline-flex items-center justify-center',
                                            'w-6 h-6 rounded-md',
                                            'bg-accent-lineage/12 text-accent-lineage',
                                        )}>
                                            <DynamicIcon name={item.icon} className="w-3.5 h-3.5" />
                                        </span>
                                        <span className="flex-1 min-w-0 flex flex-col leading-tight">
                                            <span className="text-[12.5px] text-ink truncate">
                                                {item.match
                                                    ? (
                                                        <HighlightedText
                                                            text={item.title}
                                                            query={item.match}
                                                            matchClassName="bg-accent-lineage/20 text-accent-lineage font-semibold rounded px-0.5"
                                                        />
                                                    )
                                                    : item.title}
                                            </span>
                                            {item.hint && (
                                                <span className="text-[10px] text-ink-muted/70 truncate">
                                                    {item.hint}
                                                </span>
                                            )}
                                        </span>
                                        {!item.complete && (
                                            <span className={cn(
                                                'shrink-0 text-[9.5px] font-medium',
                                                'text-amber-600 dark:text-amber-400/90',
                                            )}>
                                                needs a value
                                            </span>
                                        )}
                                    </Command.Item>
                                ))}
                            </Command.Group>
                        ))}
                    </Command.List>
                </>
            )}
        </Command>
    )
}


function labelFor(group: SuggestionGroup): string {
    return BROWSE_FACETS.find((f) => f.group === group)?.label ?? group
}
