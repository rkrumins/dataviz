import { useState } from 'react'
import { ArrowRight, ChevronRight, Sparkles, BookOpen, Package } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { TEMPLATE_CATEGORIES } from './dashboard-constants'
import type { TemplateBrief, OntologyBrief } from '@/hooks/useDashboardData'

// ───────────────────────────────────────────────────────────────────────────────
// Template Grid  (extracted from DashboardComponents — formerly BlueprintGrid)
// ───────────────────────────────────────────────────────────────────────────────

export function TemplateGrid({ title, subtitle, items, icon: Icon, onBrowseAll }: {
    title: string; subtitle?: string
    items: (TemplateBrief | OntologyBrief)[]
    icon: React.ComponentType<{ className?: string }>
    onBrowseAll?: () => void
}) {
    const [activeCategory, setActiveCategory] = useState('All')

    // Filter items by category (only applies to templates with category field)
    const filteredItems = activeCategory === 'All'
        ? items
        : items.filter(item => 'category' in item && item.category === activeCategory)

    if (items.length === 0) {
        return (
            <section className="mb-16 px-4 md:px-0">
                <div className="flex items-end justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                            <Icon className="w-4 h-4 text-ink-secondary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                            {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-12 h-12 rounded-2xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center mb-3">
                        <Icon className="w-6 h-6 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">Library is empty</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">No items yet. Create your first context model to get started.</p>
                </div>
            </section>
        )
    }

    const displayItems = filteredItems

    return (
        <section className="mb-16 px-4 md:px-0">
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-accent-business/10 border border-accent-business/20">
                        <Icon className="w-4 h-4 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                {onBrowseAll ? (
                    <button
                        onClick={onBrowseAll}
                        className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors"
                    >
                        Browse all <ChevronRight className="w-4 h-4" />
                    </button>
                ) : (
                    <button className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">
                        Browse all <ChevronRight className="w-4 h-4" />
                    </button>
                )}
            </div>

            <div className="flex items-center gap-2 mb-5 overflow-x-auto pb-1">
                {TEMPLATE_CATEGORIES.map(c => (
                    <button key={c} onClick={() => setActiveCategory(c)}
                        className={cn('px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all shrink-0',
                            activeCategory === c ? 'bg-accent-business text-white shadow-lg shadow-accent-business/20' : 'glass-panel border border-glass-border text-ink-muted hover:text-ink'
                        )}>{c}</button>
                ))}
            </div>

            {displayItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-10 rounded-2xl border border-dashed border-glass-border">
                    <p className="text-sm text-ink-muted">No items match the selected filter.</p>
                    <button
                        onClick={() => setActiveCategory('All')}
                        className="mt-2 text-sm font-medium text-accent-business hover:underline"
                    >
                        Show all
                    </button>
                </div>
            ) : (
                <>
                    {/* Featured */}
                    <div className="mb-4">
                        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                            className="group relative glass-panel rounded-2xl border border-accent-business/20 hover:border-accent-business/40 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-accent-business/10 cursor-pointer"
                        >
                            <div className="absolute inset-0 bg-gradient-to-r from-accent-business/5 to-accent-explore/3 pointer-events-none" />
                            <div className="relative p-5 flex items-center gap-5">
                                <div className="w-12 h-12 rounded-2xl bg-accent-business/10 border border-accent-business/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                    <Sparkles className="w-6 h-6 text-accent-business" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-accent-business">Featured</span>
                                    </div>
                                    <h4 className="font-bold text-lg text-ink group-hover:text-accent-business transition-colors mb-0.5 leading-tight">{displayItems[0].name}</h4>
                                    <p className="text-sm text-ink-muted line-clamp-1">{displayItems[0].description || 'Ready-to-deploy semantic context model.'}</p>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                    {'version' in displayItems[0] && (
                                        <span className="text-xs font-semibold text-ink-muted border border-glass-border rounded-lg px-2 py-1">v{displayItems[0].version || 1}</span>
                                    )}
                                    <button
                                        disabled
                                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent-business/40 text-white/70 font-semibold text-sm cursor-not-allowed shadow-md shadow-accent-business/10"
                                    >
                                        Deploy <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </div>

                    {displayItems.length > 1 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {displayItems.slice(1).map((item, i) => (
                                <motion.div key={item.id}
                                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.2 }}
                                    className="group glass-panel rounded-2xl border border-glass-border hover:border-accent-business/40 hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer p-4 flex items-start gap-3.5"
                                >
                                    <div className="w-10 h-10 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center shrink-0 group-hover:bg-accent-business/10 group-hover:border-accent-business/20 transition-all">
                                        {'version' in item ? (
                                            <Package className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                        ) : (
                                            <BookOpen className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0 pt-0.5">
                                        <h4 className="font-semibold text-sm text-ink group-hover:text-accent-business transition-colors truncate mb-1">{item.name}</h4>
                                        <p className="text-xs text-ink-muted line-clamp-2">{item.description || 'Semantic model template'}</p>
                                        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-glass-border/40">
                                            <span className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">
                                                {'version' in item ? `v${item.version || 1}` : 'Template'}
                                            </span>
                                            <ArrowRight className="w-3.5 h-3.5 text-ink-muted/0 group-hover:text-accent-business transition-all group-hover:translate-x-0.5" />
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </section>
    )
}

/** @deprecated Use TemplateGrid */
export const BlueprintGrid = TemplateGrid
