import { ArrowRight, ChevronRight, LayoutTemplate, Plus, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { AudienceBadge } from '@/components/templates/TemplateCard'
import { TemplatePreview } from '@/components/templates/TemplatePreview'
import type { LayoutTemplate as Template } from '@/services/layoutTemplateService'

// ───────────────────────────────────────────────────────────────────────────────
// Layout templates on the Dashboard: the library's most used, one click from a
// new Context View. Everything else about them lives on the Templates page.
// ───────────────────────────────────────────────────────────────────────────────

const SHOWN = 6

export function TemplateGrid({ templates, onUse, onOpen, onBrowseAll, onCreate }: {
    templates: Template[]
    onUse: (template: Template) => void
    onOpen: (template: Template) => void
    onBrowseAll: () => void
    onCreate: () => void
}) {
    const ranked = [...templates].sort((a, b) => b.usageCount - a.usageCount || b.updatedAt.localeCompare(a.updatedAt))
    const [featured, ...rest] = ranked.slice(0, SHOWN)

    return (
        <section className="mb-16">
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-accent-business/10 border border-accent-business/20">
                        <LayoutTemplate className="w-4 h-4 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">Layout templates</h2>
                        <p className="text-xs text-ink-muted mt-0.5">
                            Start a Context View from a proven layout — yours, your teams' or a built-in
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onBrowseAll}
                    className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors"
                >
                    Browse all {templates.length > 0 && <span className="tabular-nums">({templates.length})</span>}
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {!featured ? (
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-12 h-12 rounded-2xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center mb-3">
                        <LayoutTemplate className="w-6 h-6 text-ink-muted/40" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">No templates to start from</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs mb-4">
                        Keep a layer layout you like as a template, and reuse it for every new view.
                    </p>
                    <button
                        type="button"
                        onClick={onCreate}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent-business text-white text-sm font-semibold shadow-md shadow-accent-business/20"
                    >
                        <Plus className="w-4 h-4" /> New template
                    </button>
                </div>
            ) : (
                <>
                    <motion.div
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                        onClick={() => onOpen(featured)}
                        className="group relative mb-4 glass-panel rounded-2xl border border-accent-business/20 hover:border-accent-business/40 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-accent-business/10 cursor-pointer"
                    >
                        <div className="absolute inset-0 bg-gradient-to-r from-accent-business/5 to-accent-explore/3 pointer-events-none" />
                        <div className="relative p-5 flex flex-wrap items-center gap-5">
                            <div className="w-12 h-12 rounded-2xl bg-accent-business/10 border border-accent-business/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                <Sparkles className="w-6 h-6 text-accent-business" />
                            </div>
                            <div className="flex-1 min-w-[12rem]">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-accent-business">
                                        {featured.usageCount > 0 ? 'Most used' : 'Featured'}
                                    </span>
                                    <AudienceBadge template={featured} />
                                </div>
                                <h4 className="font-bold text-lg text-ink group-hover:text-accent-business transition-colors mb-0.5 leading-tight">{featured.name}</h4>
                                <p className="text-sm text-ink-muted line-clamp-1">
                                    {featured.description || `${featured.layers.length} layers, ready to fill with your data.`}
                                </p>
                            </div>
                            <div className="w-full sm:w-64 shrink-0">
                                <TemplatePreview layers={featured.layers} />
                            </div>
                            <button
                                type="button"
                                onClick={e => { e.stopPropagation(); onUse(featured) }}
                                className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent-business text-white font-semibold text-sm shadow-md shadow-accent-business/20 hover:brightness-110 transition"
                            >
                                Use template <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </motion.div>

                    {rest.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 wide:grid-cols-5 gap-4">
                            {rest.map((t, i) => (
                                <motion.div
                                    key={t.id}
                                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.2 }}
                                    onClick={() => onOpen(t)}
                                    className="group glass-panel rounded-2xl border border-glass-border hover:border-accent-business/40 hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer p-4 flex flex-col"
                                >
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <h4 className="font-semibold text-sm text-ink group-hover:text-accent-business transition-colors truncate flex-1">{t.name}</h4>
                                        <AudienceBadge template={t} />
                                    </div>
                                    <p className="text-xs text-ink-muted line-clamp-2 min-h-[2rem] mb-3">
                                        {t.description || `${t.layers.length} layers`}
                                    </p>
                                    <TemplatePreview layers={t.layers} />
                                    <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-glass-border/40">
                                        <span className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">
                                            {t.usageCount > 0 ? `Used in ${t.usageCount}` : 'Template'}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={e => { e.stopPropagation(); onUse(t) }}
                                            className="flex items-center gap-1 text-xs font-semibold text-accent-business opacity-70 group-hover:opacity-100 transition-opacity"
                                        >
                                            Use <ArrowRight className="w-3.5 h-3.5" />
                                        </button>
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
