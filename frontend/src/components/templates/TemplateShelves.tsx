/**
 * The library's front shelves, above the full collection: what template
 * managers feature, and what this person used last.
 */
import { useRef } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, History, Star } from 'lucide-react'
import { timeAgo } from '@/lib/timeAgo'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { TemplatePreview } from './TemplatePreview'

export function FeaturedShelf({ templates, renderCard }: {
    templates: readonly LayoutTemplate[]
    renderCard: (template: LayoutTemplate) => React.ReactNode
}) {
    const track = useRef<HTMLDivElement>(null)
    const scroll = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' })
    if (templates.length === 0) return null
    return (
        <section aria-labelledby="featured-templates">
            <div className="flex items-center gap-2 mb-3">
                <h2 id="featured-templates" className="text-sm font-bold text-ink flex items-center gap-1.5">
                    <Star className="w-4 h-4 text-amber-500" fill="currentColor" aria-hidden /> Featured
                </h2>
                <span className="text-[11px] text-ink-muted">Picked by your template managers</span>
                {templates.length > 2 && (
                    <div className="ml-auto flex gap-1">
                        <button type="button" onClick={() => scroll(-1)} aria-label="Previous featured templates" className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-ink-muted hover:text-ink">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => scroll(1)} aria-label="Next featured templates" className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-ink-muted hover:text-ink">
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>
            <div ref={track} className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-2 custom-scrollbar">
                {templates.map(t => (
                    <div key={t.id} className="snap-start shrink-0 w-[320px] rounded-2xl ring-1 ring-amber-400/30">
                        {renderCard(t)}
                    </div>
                ))}
            </div>
        </section>
    )
}

export function RecentShelf({ templates, onOpen, onUse }: {
    templates: readonly LayoutTemplate[]
    onOpen: (template: LayoutTemplate) => void
    onUse: (template: LayoutTemplate) => void
}) {
    if (templates.length === 0) return null
    return (
        <section aria-labelledby="recent-templates">
            <h2 id="recent-templates" className="text-sm font-bold text-ink flex items-center gap-1.5 mb-3">
                <History className="w-4 h-4 text-indigo-500" aria-hidden /> Recently used
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {templates.map(t => (
                    <div key={t.id} className="group rounded-xl border border-slate-200 dark:border-slate-700 bg-canvas-elevated p-3">
                        <button type="button" onClick={() => onOpen(t)} className="block w-full text-left">
                            <TemplatePreview layers={t.layers} />
                            <span className="block mt-2 text-sm font-semibold text-ink truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{t.name}</span>
                        </button>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-ink-muted flex-1">Used {timeAgo(t.lastUsedAt!)}</span>
                            <button type="button" onClick={() => onUse(t)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                                Use <ArrowRight className="w-3 h-3" aria-hidden />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    )
}
