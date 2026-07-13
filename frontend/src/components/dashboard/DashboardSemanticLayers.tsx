/**
 * "Semantic layers" — the shared business meaning over the data.
 *
 * This section was rendered through TemplateGrid, the STARTER-TEMPLATE grid, which
 * meant three things were wrong at once:
 *
 *   1. The cards weren't clickable. Only "Browse all" did anything, so a layer you
 *      could see was a layer you couldn't open — the section was decoration.
 *   2. It inherited the template grid's category filter, which no semantic layer
 *      has, so the control was always a no-op.
 *   3. The dashboard fetched /api/v1/admin/ontologies by hand into its own cache,
 *      a second copy of what the Semantic Layers page already reads through
 *      `useOntologies`. Publish a layer there and this list kept serving the stale
 *      version for its 5-minute staleTime. It now reads the SAME query key, so an
 *      edit on that page invalidates this too.
 *
 * The cards now say what a layer IS — how many entity and relationship types it
 * defines, and whether it's published or still a draft — and each one opens it.
 */
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BookOpen, ArrowRight, Box, Share2, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

/** How many types a layer defines. The record is keyed by type id. */
function countOf(defs: Record<string, unknown> | undefined | null): number {
    return defs ? Object.keys(defs).length : 0
}

function LayerCard({ layer, index }: { layer: OntologyDefinitionResponse; index: number }) {
    const entityTypes = countOf(layer.entityTypeDefinitions as Record<string, unknown>)
    const relTypes = countOf(layer.relationshipTypeDefinitions as Record<string, unknown>)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 6) * 0.04, duration: 0.2 }}
        >
            <Link
                to={`/schema/${layer.id}`}
                className={cn(
                    'group relative flex flex-col h-full rounded-2xl border p-4 overflow-hidden',
                    'glass-panel border-glass-border hover:border-accent-explore/40',
                    'hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200',
                )}
            >
                <div className="absolute inset-0 bg-gradient-to-br from-accent-explore/[0.07] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                <div className="relative flex items-start gap-3 mb-3">
                    <span className="w-9 h-9 rounded-xl border border-accent-explore/25 bg-accent-explore/10 text-accent-explore flex items-center justify-center shrink-0">
                        <BookOpen className="w-4 h-4" />
                    </span>

                    <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink truncate group-hover:text-accent-explore transition-colors">
                            {layer.name}
                        </span>
                        <span className="block text-[11px] text-ink-muted truncate mt-0.5">
                            {layer.description || `Version ${layer.version}`}
                        </span>
                    </span>
                </div>

                {/* Published vs draft is the fact that decides whether anything is
                    actually USING this layer — say it, don't bury it. */}
                <div className="relative flex items-center gap-1.5 mb-3 flex-wrap">
                    <span className={cn(
                        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                        layer.isPublished
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                    )}>
                        {layer.isPublished ? 'Published' : 'Draft'}
                    </span>

                    {layer.isSystem && (
                        <span
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-black/5 dark:bg-white/10 text-ink-muted"
                            title="Built in — this layer ships with the product and can't be edited"
                        >
                            <Lock className="w-2.5 h-2.5" />
                            Built in
                        </span>
                    )}

                    <span className="text-[10px] font-semibold text-ink-muted tabular-nums">
                        v{layer.version}
                    </span>
                </div>

                <div className="relative mt-auto flex items-center justify-between gap-2 pt-2 border-t border-glass-border/60">
                    <span className="flex items-center gap-3 text-[11px] text-ink-muted min-w-0">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <Box className="w-3 h-3 shrink-0" />
                            {entityTypes} {entityTypes === 1 ? 'type' : 'types'}
                        </span>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <Share2 className="w-3 h-3 shrink-0" />
                            {relTypes} {relTypes === 1 ? 'link' : 'links'}
                        </span>
                    </span>

                    <ArrowRight className="w-3.5 h-3.5 shrink-0 text-ink-muted opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </div>
            </Link>
        </motion.div>
    )
}

export function DashboardSemanticLayers({ layers }: { layers: OntologyDefinitionResponse[] }) {
    if (layers.length === 0) return null

    const published = layers.filter(l => l.isPublished).length

    return (
        <section className="px-4 md:px-0 mb-14">
            <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center shrink-0">
                    <BookOpen className="w-4 h-4 text-ink-muted" />
                </div>
                <div className="flex items-baseline gap-2 flex-1 min-w-0">
                    <h2 className="text-ink text-sm font-bold whitespace-nowrap">Semantic layers</h2>
                    <span className="text-ink-muted text-xs truncate hidden sm:inline">
                        The shared business meaning behind your data
                        {published > 0 && ` · ${published} published`}
                    </span>
                </div>

                <Link
                    to="/schema"
                    className="group inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
                >
                    See all
                    <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {layers.slice(0, 8).map((l, i) => (
                    <LayerCard key={l.id} layer={l} index={i} />
                ))}
            </div>
        </section>
    )
}
