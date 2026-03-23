import { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    ArrowRight,
    Zap,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { QUICK_SUGGESTIONS, CATEGORY_COLORS } from './dashboard-constants'

export type DashboardSearchResult = {
    id: string
    label: string
    sublabel?: string
    category: 'Workspace' | 'Data Source' | 'View' | 'Template' | 'Semantic Layer'
    icon: React.ComponentType<{ className?: string }>
    onSelect: () => void
}

export function DashboardHero({ value, onChange, results }: {
    value: string
    onChange: (q: string) => void
    results: DashboardSearchResult[]
}) {
    const [focused, setFocused] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const showDropdown = focused && value.trim().length > 0

    // Close dropdown when clicking outside
    const handleBlur = () => {
        // Delay so click on result fires first
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
                            placeholder="Search workspaces, views, data sources, templates…"
                            className="flex-1 bg-transparent border-none py-5 px-4 text-lg text-ink outline-none placeholder:text-ink-muted/40 font-medium"
                        />
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
                                className="absolute left-0 right-0 top-full z-50 bg-canvas/98 backdrop-blur-2xl border border-t-0 border-accent-business/40 rounded-b-2xl shadow-2xl max-h-80 overflow-y-auto"
                            >
                                {results.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-10 gap-2">
                                        <Search className="w-7 h-7 text-ink-muted/30" />
                                        <p className="text-sm font-semibold text-ink">No results for "{value}"</p>
                                        <p className="text-xs text-ink-muted">Try a workspace name, view, or data source</p>
                                    </div>
                                ) : (
                                    <div className="py-2">
                                        {results.map((r, i) => (
                                            <button
                                                key={r.id}
                                                onMouseDown={e => { e.preventDefault(); r.onSelect(); onChange('') }}
                                                className={cn(
                                                    'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors group/res',
                                                    i > 0 && results[i - 1].category !== r.category ? 'border-t border-glass-border/40' : ''
                                                )}
                                            >
                                                <div className={cn('w-8 h-8 rounded-xl border flex items-center justify-center shrink-0', CATEGORY_COLORS[r.category])}>
                                                    <r.icon className="w-4 h-4" />
                                                </div>
                                                <div className="flex-1 min-w-0 text-left">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-semibold text-ink group-hover/res:text-accent-business transition-colors truncate">{r.label}</span>
                                                        <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0', CATEGORY_COLORS[r.category])}>{r.category}</span>
                                                    </div>
                                                    {r.sublabel && <p className="text-xs text-ink-muted truncate mt-0.5">{r.sublabel}</p>}
                                                </div>
                                                <ArrowRight className="w-4 h-4 text-ink-muted/0 group-hover/res:text-accent-business transition-all group-hover/res:translate-x-0.5 shrink-0" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="px-4 py-2 border-t border-glass-border/30 flex items-center justify-between">
                                    <span className="text-[11px] text-ink-muted">{results.length} result{results.length !== 1 ? 's' : ''}</span>
                                    <span className="text-[11px] text-ink-muted">↵ to select · Esc to close</span>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Quick suggestions — hide while searching */}
                {!value && (
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
