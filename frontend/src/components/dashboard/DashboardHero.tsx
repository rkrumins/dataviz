import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    ArrowRight,
    Zap,
    X,
    Globe,
    Database,
    Eye,
    LayoutTemplate,
    BookOpen,
    Loader2,
    Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { QUICK_SUGGESTIONS, CATEGORY_COLORS, type SearchResultCategory } from './dashboard-constants'
import { CATEGORY_ORDER, type GlobalSearchResult, type SearchHit, type SearchCategory } from '@/hooks/useGlobalSearch'
import { HighlightedText } from '@/components/ui/HighlightedText'

const CATEGORY_ICONS: Record<SearchResultCategory, React.ComponentType<{ className?: string }>> = {
    Workspace: Globe,
    'Data Source': Database,
    View: Eye,
    Template: LayoutTemplate,
    'Semantic Layer': BookOpen,
}

interface DashboardHeroProps {
    value: string
    onChange: (q: string) => void
    result: GlobalSearchResult
    onSelectHit: (hit: SearchHit) => void
    onShowAll?: (category: SearchCategory) => void
    recentSearches?: string[]
    onRemoveRecentSearch?: (q: string) => void
    onClearRecentSearches?: () => void
}

export function DashboardHero({
    value,
    onChange,
    result,
    onSelectHit,
    onShowAll,
    recentSearches = [],
    onRemoveRecentSearch,
    onClearRecentSearches,
}: DashboardHeroProps) {
    const [focused, setFocused] = useState(false)
    const [activeIndex, setActiveIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const trimmed = value.trim()
    const showResultsDropdown = focused && trimmed.length > 0
    const showRecentsDropdown = focused && trimmed.length === 0 && recentSearches.length > 0
    const showDropdown = showResultsDropdown || showRecentsDropdown

    const flatHits = useMemo<SearchHit[]>(() => {
        const out: SearchHit[] = []
        for (const cat of CATEGORY_ORDER) out.push(...result.byCategory[cat])
        return out
    }, [result])

    const totalDisplayed = flatHits.length

    useEffect(() => {
        // Reset cursor when the underlying list changes (results or mode swap).
        setActiveIndex(0)
    }, [result, showRecentsDropdown])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!showDropdown) return
        if (e.key === 'Escape') {
            setFocused(false)
            inputRef.current?.blur()
            return
        }
        if (showRecentsDropdown) {
            const max = Math.max(recentSearches.length - 1, 0)
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex(i => Math.min(i + 1, max))
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex(i => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
                const q = recentSearches[activeIndex]
                if (q) {
                    e.preventDefault()
                    onChange(q)
                }
            }
            return
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex(i => Math.min(i + 1, Math.max(totalDisplayed - 1, 0)))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
            const hit = flatHits[activeIndex]
            if (hit) {
                e.preventDefault()
                onSelectHit(hit)
            }
        }
    }

    const handleBlur = () => {
        // Delay so click on result fires first.
        setTimeout(() => setFocused(false), 150)
    }

    return (
        <section className="relative w-full flex flex-col items-center justify-center pt-14 pb-10 px-4 text-center overflow-visible">
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-[900px] h-[400px] bg-accent-business/8 blur-[140px] rounded-[100%]" />
            </div>
            <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 w-full max-w-2xl"
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.05, duration: 0.2 }}
                    className="inline-flex items-center gap-2 mb-5 px-4 py-1.5 rounded-full glass-panel border border-accent-business/30 text-accent-business text-sm font-semibold"
                >
                    <Zap className="w-3.5 h-3.5" />
                    Data Intelligence Platform
                </motion.div>
                <h1 className="text-4xl md:text-5xl font-extrabold text-ink tracking-tight mb-3 leading-[1.1]">
                    What would you like<br className="hidden md:block" /> to{' '}
                    <span className="bg-gradient-to-r from-accent-business to-accent-explore bg-clip-text text-transparent">
                        explore?
                    </span>
                </h1>
                <p className="text-base text-ink-muted mb-8 max-w-md mx-auto">
                    Search across workspaces, views, and data sources — or jump to a template.
                </p>

                {/* Search box + dropdown */}
                <div ref={containerRef} className={cn('relative group transition-all duration-500', focused ? 'scale-[1.02]' : 'scale-100')}>
                    {/* Glow */}
                    <div className={cn(
                        'absolute -inset-1 rounded-3xl blur-md transition-opacity duration-700',
                        focused
                            ? 'opacity-100 bg-gradient-to-r from-accent-business/40 via-accent-explore/30 to-accent-lineage/40'
                            : 'opacity-0 group-hover:opacity-50 bg-gradient-to-r from-accent-business/20 to-accent-lineage/10'
                    )} />

                    {/* Input bar */}
                    <div className={cn(
                        'relative flex items-center bg-canvas/95 backdrop-blur-2xl border shadow-2xl transition-all duration-300 overflow-hidden',
                        showDropdown ? 'rounded-t-2xl rounded-b-none border-accent-business/60 border-b-glass-border/30' : 'rounded-2xl',
                        focused && !showDropdown ? 'border-accent-business/60' : !focused ? 'border-glass-border' : ''
                    )}>
                        <Search className={cn('w-6 h-6 ml-5 shrink-0 transition-colors duration-200', focused ? 'text-accent-business' : 'text-ink-muted')} />
                        <input
                            ref={inputRef}
                            type="text"
                            value={value}
                            onChange={e => onChange(e.target.value)}
                            onFocus={() => setFocused(true)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            placeholder="Search workspaces, views, data sources, templates…"
                            className="flex-1 bg-transparent border-none py-5 px-4 text-lg text-ink outline-none placeholder:text-ink-muted/40 font-medium"
                        />
                        {result.isLoading && (
                            <Loader2 className="w-4 h-4 mr-2 text-ink-muted/60 animate-spin" />
                        )}
                        {value && (
                            <button
                                onMouseDown={e => { e.preventDefault(); onChange('') }}
                                className="mr-2 w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/10 transition-all"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                        <div className="mr-4">
                            <kbd className="hidden sm:flex items-center gap-1 rounded-lg border border-glass-border bg-black/5 dark:bg-white/5 px-2.5 py-1 text-sm font-medium text-ink-muted">
                                <span className="text-base leading-none">⌘</span>K
                            </kbd>
                        </div>
                    </div>

                    {/* Results dropdown */}
                    <AnimatePresence>
                        {showDropdown && (
                            <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.15 }}
                                className="absolute left-0 right-0 top-full z-50 bg-canvas/98 backdrop-blur-2xl border border-t-0 border-accent-business/40 rounded-b-2xl shadow-2xl max-h-[28rem] overflow-y-auto custom-scrollbar"
                            >
                                {showRecentsDropdown ? (
                                    <RecentSearches
                                        recents={recentSearches}
                                        activeIndex={activeIndex}
                                        onSelect={(q) => onChange(q)}
                                        onRemove={onRemoveRecentSearch}
                                        onClear={onClearRecentSearches}
                                    />
                                ) : totalDisplayed === 0 && !result.isLoading ? (
                                    <EmptyResults query={value} />
                                ) : (
                                    <GroupedResults
                                        result={result}
                                        activeIndex={activeIndex}
                                        onSelectHit={onSelectHit}
                                        onShowAll={onShowAll}
                                        onCommit={() => onChange('')}
                                    />
                                )}
                                <div className="px-4 py-2 border-t border-glass-border/30 flex items-center justify-between">
                                    <span className="text-[11px] text-ink-muted">
                                        {showRecentsDropdown
                                            ? `${recentSearches.length} recent search${recentSearches.length !== 1 ? 'es' : ''}`
                                            : `${totalDisplayed} result${totalDisplayed !== 1 ? 's' : ''}`}
                                    </span>
                                    <span className="text-[11px] text-ink-muted">↑↓ navigate · ↵ select · Esc close</span>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Quick suggestions — hide while the dropdown is open so it can't sit on top of recents/results. */}
                {!value && !showDropdown && (
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                        <span className="text-[11px] font-bold text-ink-muted uppercase tracking-widest mr-1">Jump to:</span>
                        {QUICK_SUGGESTIONS.map((s, i) => (
                            <motion.button
                                key={s.label}
                                onClick={(e) => {
                                    e.preventDefault()
                                    onChange(s.label)
                                    setFocused(true)
                                    setTimeout(() => inputRef.current?.focus(), 50)
                                }}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.15 + i * 0.03 }}
                                className="group flex items-center gap-1.5 px-3.5 py-1.5 rounded-full glass-panel border border-glass-border text-sm font-medium text-ink-muted hover:text-accent-business hover:border-accent-business/40 hover:bg-accent-business/5 transition-all"
                            >
                                <s.icon className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                                {s.label}
                            </motion.button>
                        ))}
                    </div>
                )}
            </motion.div>
        </section>
    )
}

function EmptyResults({ query }: { query: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
            <Search className="w-7 h-7 text-ink-muted/30" />
            <p className="text-sm font-semibold text-ink">No results for "{query}"</p>
            <p className="text-xs text-ink-muted">Try a workspace name, view, or data source</p>
        </div>
    )
}

interface RecentSearchesProps {
    recents: string[]
    activeIndex: number
    onSelect: (q: string) => void
    onRemove?: (q: string) => void
    onClear?: () => void
}

function RecentSearches({ recents, activeIndex, onSelect, onRemove, onClear }: RecentSearchesProps) {
    return (
        <div className="py-2">
            <div className="flex items-center justify-between px-4 pt-2 pb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    Recent searches
                </span>
                {onClear && (
                    <button
                        type="button"
                        onMouseDown={e => { e.preventDefault(); onClear() }}
                        className="text-[10px] font-medium text-ink-muted hover:text-accent-business transition-colors"
                    >
                        Clear
                    </button>
                )}
            </div>
            {recents.map((q, i) => {
                const active = i === activeIndex
                return (
                    <div
                        key={q}
                        className={cn(
                            'flex items-center gap-3 px-4 py-2 group/recent transition-colors',
                            active ? 'bg-accent-business/8' : 'hover:bg-black/5 dark:hover:bg-white/5'
                        )}
                    >
                        <button
                            type="button"
                            onMouseDown={e => { e.preventDefault(); onSelect(q) }}
                            className="flex flex-1 items-center gap-3 min-w-0 text-left"
                        >
                            <div className="w-8 h-8 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center shrink-0">
                                <Clock className="w-4 h-4 text-ink-muted" />
                            </div>
                            <span className="text-sm text-ink truncate">{q}</span>
                        </button>
                        {onRemove && (
                            <button
                                type="button"
                                onMouseDown={e => { e.preventDefault(); onRemove(q) }}
                                className="opacity-0 group-hover/recent:opacity-100 w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/10 transition-all shrink-0"
                                title="Remove from history"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

interface GroupedResultsProps {
    result: GlobalSearchResult
    activeIndex: number
    onSelectHit: (hit: SearchHit) => void
    onShowAll?: (category: SearchCategory) => void
    onCommit: () => void
}

function GroupedResults({ result, activeIndex, onSelectHit, onShowAll, onCommit }: GroupedResultsProps) {
    let runningIndex = 0
    return (
        <div className="py-2">
            {CATEGORY_ORDER.map(category => {
                const hits = result.byCategory[category]
                if (hits.length === 0) return null
                const total = result.totalByCategory[category]
                const hidden = Math.max(0, total - hits.length)
                const Icon = CATEGORY_ICONS[category]
                const sectionStart = runningIndex
                runningIndex += hits.length
                return (
                    <div key={category} className="mb-1 last:mb-0">
                        <div className="flex items-center gap-2 px-4 pt-2 pb-1">
                            <Icon className="w-3 h-3 text-ink-muted" />
                            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                                {category}{hits.length > 1 ? 's' : ''}
                            </span>
                            <span className="text-[10px] text-ink-muted/60">{total}</span>
                        </div>
                        {hits.map((hit, i) => {
                            const idx = sectionStart + i
                            return (
                                <ResultRow
                                    key={hit.id}
                                    hit={hit}
                                    query={result.query}
                                    active={idx === activeIndex}
                                    onClick={() => { onSelectHit(hit); onCommit() }}
                                />
                            )
                        })}
                        {hidden > 0 && (
                            <button
                                type="button"
                                onMouseDown={e => {
                                    e.preventDefault()
                                    if (onShowAll) onShowAll(category)
                                }}
                                className={cn(
                                    'w-full flex items-center justify-between px-4 py-2 text-left text-xs',
                                    'text-ink-muted hover:text-accent-business hover:bg-accent-business/5 transition-colors',
                                    onShowAll ? 'cursor-pointer' : 'cursor-default'
                                )}
                                disabled={!onShowAll}
                            >
                                <span>+ {hidden} more {category.toLowerCase()}{hidden > 1 ? 's' : ''}</span>
                                {onShowAll && <span className="font-semibold">Show all →</span>}
                            </button>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

interface ResultRowProps {
    hit: SearchHit
    query: string
    active: boolean
    onClick: () => void
}

function ResultRow({ hit, query, active, onClick }: ResultRowProps) {
    const Icon = CATEGORY_ICONS[hit.category]
    return (
        <button
            type="button"
            onMouseDown={e => { e.preventDefault(); onClick() }}
            className={cn(
                'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors group/res',
                active ? 'bg-accent-business/8' : 'hover:bg-black/5 dark:hover:bg-white/5'
            )}
        >
            <div className={cn(
                'w-8 h-8 rounded-xl border flex items-center justify-center shrink-0',
                CATEGORY_COLORS[hit.category]
            )}>
                <Icon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink group-hover/res:text-accent-business transition-colors truncate">
                        <HighlightedText text={hit.name} query={query} />
                    </span>
                    <span className={cn(
                        'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0',
                        CATEGORY_COLORS[hit.category]
                    )}>
                        {hit.category}
                    </span>
                </div>
                {hit.description && (
                    <p className="text-xs text-ink-muted truncate mt-0.5">
                        <HighlightedText text={hit.description} query={query} />
                    </p>
                )}
            </div>
            <ArrowRight className={cn(
                'w-4 h-4 transition-all shrink-0',
                active
                    ? 'text-accent-business translate-x-0.5'
                    : 'text-ink-muted/0 group-hover/res:text-accent-business group-hover/res:translate-x-0.5'
            )} />
        </button>
    )
}
