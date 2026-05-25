/**
 * FeaturedTemplateCard — horizontal hero variant of TemplateCard.
 *
 * Highlighted at the top of the gallery when a clear winner exists
 * (pinned, most-instantiated, or most-recently updated). One card per
 * gallery; the rest of the templates render in the uniform grid below.
 */
import { motion } from 'framer-motion'
import {
    Sparkles, ArrowRight, Pin, Layers as LayersIcon, Star, Globe2, Building2,
} from 'lucide-react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useCountUp } from '@/components/canvas/trace/useCountUp'
import type { ContextModel } from '@/services/contextModelService'
import { cn } from '@/lib/utils'

interface FeaturedTemplateCardProps {
    template: ContextModel
    onOpen: (template: ContextModel) => void
}

const DEFAULT_ACCENT = '#6366f1'
const DEFAULT_ICON = 'LayoutTemplate'

export function FeaturedTemplateCard({ template, onOpen }: FeaturedTemplateCardProps) {
    const accent = template.accentColor || DEFAULT_ACCENT
    const icon = template.icon || DEFAULT_ICON
    const isGlobal = template.workspaceId == null
    const layerCount = template.layersConfig?.length ?? 0
    const animatedCount = useCountUp(template.instantiationCount)

    return (
        <motion.button
            type="button"
            onClick={() => onOpen(template)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="group relative w-full text-left rounded-2xl border border-glass-border overflow-hidden hover:-translate-y-0.5 transition-transform"
            style={{
                backgroundImage: `linear-gradient(135deg, ${accent}18 0%, ${accent}06 35%, transparent 65%)`,
            }}
        >
            {/* Top accent bar */}
            <div className="h-1 w-full" style={{ backgroundColor: accent }} aria-hidden />

            <div className="p-6 flex items-center gap-5">
                {/* Icon block */}
                <div
                    className="w-20 h-20 rounded-2xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105"
                    style={{
                        backgroundColor: `${accent}1f`,
                        color: accent,
                        border: `1px solid ${accent}40`,
                        boxShadow: `0 6px 24px -8px ${accent}50`,
                    }}
                >
                    <DynamicIcon name={icon} className="w-9 h-9" />
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                            style={{ backgroundColor: `${accent}25`, color: accent }}
                        >
                            <Sparkles className="w-2.5 h-2.5" />
                            Featured
                        </span>
                        {template.isPinned && (
                            <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-black/5 dark:bg-white/5 text-ink-muted"
                                title="Pinned by maintainers"
                            >
                                <Pin className="w-2.5 h-2.5" />
                                Pinned
                            </span>
                        )}
                        <span
                            className={cn(
                                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
                                isGlobal
                                    ? 'bg-blue-500/10 text-blue-500'
                                    : 'bg-emerald-500/10 text-emerald-500',
                            )}
                        >
                            {isGlobal ? <Globe2 className="w-2.5 h-2.5" /> : <Building2 className="w-2.5 h-2.5" />}
                            {isGlobal ? 'Global' : 'Workspace'}
                        </span>
                    </div>

                    <h3 className="text-xl font-bold text-ink tracking-tight truncate">
                        {template.name}
                    </h3>
                    <p className="text-sm text-ink-secondary mt-1 line-clamp-2 leading-relaxed">
                        {template.description || 'A premium ContextViewCanvas blueprint ready to instantiate.'}
                    </p>

                    <div className="flex items-center gap-4 mt-3 text-xs text-ink-muted">
                        <span className="inline-flex items-center gap-1">
                            <LayersIcon className="w-3 h-3" />
                            {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <Star className="w-3 h-3" />
                            <span className="tabular-nums">{animatedCount}</span> instantiations
                        </span>
                        {template.category && (
                            <span className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5">
                                {template.category}
                            </span>
                        )}
                    </div>
                </div>

                {/* CTA */}
                <div className="hidden md:flex shrink-0">
                    <div
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white shadow-md transition-shadow group-hover:shadow-lg"
                        style={{ backgroundColor: accent, boxShadow: `0 8px 24px -10px ${accent}` }}
                    >
                        Open
                        <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                    </div>
                </div>
            </div>
        </motion.button>
    )
}

