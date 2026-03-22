/**
 * ReviewStep — Final review summary and animated success screen for the onboarding wizard.
 * Two phases: pre-submit review and post-submit success with CTAs and auto-redirect.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Package, Database, BookOpen, Settings, Search, Sparkles, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CatalogItemResponse } from '@/services/catalogService'
import type { OnboardingFormData } from '../AssetOnboardingWizard'

interface ReviewStepProps {
    formData: OnboardingFormData
    catalogItems: CatalogItemResponse[]
    phase: 'review' | 'success'
    onNavigate: (destination: 'explore' | 'create-view' | 'configure-more') => void
    workspaceNames: Record<string, string>
    ontologyNames: Record<string, string>
}

function getWorkspaceLabel(
    itemId: string,
    formData: OnboardingFormData,
    workspaceNames: Record<string, string>,
): string {
    const alloc = formData.allocations[itemId]
    if (!alloc) return 'Unassigned'
    if (alloc.workspaceId === 'new') return alloc.newWorkspaceName || 'New Workspace'
    if (alloc.workspaceId) return workspaceNames[alloc.workspaceId] || alloc.workspaceId
    return 'Unassigned'
}

function getOntologyLabel(
    itemId: string,
    formData: OnboardingFormData,
    ontologyNames: Record<string, string>,
): string {
    const sel = formData.ontologySelections[itemId]
    if (!sel || !sel.ontologyId) return 'None'
    if (sel.ontologyId === 'new') return 'New (from suggestion)'
    return ontologyNames[sel.ontologyId] || sel.ontologyId
}

function getCoveragePct(itemId: string, formData: OnboardingFormData): number | null {
    const sel = formData.ontologySelections[itemId]
    if (!sel?.coverageStats) return null
    const stats = sel.coverageStats
    const total = (stats.totalEntityTypes ?? 0) + (stats.totalRelationshipTypes ?? 0)
    if (total === 0) return null
    const covered = (stats.coveredEntityTypes?.length ?? 0) + (stats.coveredRelationshipTypes?.length ?? 0)
    return Math.round((covered / total) * 100)
}

/* ---------- Review Phase ---------- */
function ReviewPhase({
    formData,
    catalogItems,
    workspaceNames,
    ontologyNames,
}: Omit<ReviewStepProps, 'phase' | 'onNavigate'>) {
    const uniqueWorkspaces = new Set(
        Object.values(formData.allocations)
            .map(a => a.workspaceId)
            .filter(Boolean),
    )
    const uniqueOntologies = new Set(
        Object.values(formData.ontologySelections)
            .map(s => s.ontologyId)
            .filter(Boolean),
    )

    return (
        <div className="space-y-6">
            {/* Summary card */}
            <div className="glass-panel rounded-2xl divide-y divide-glass-border overflow-hidden">
                {/* Data Products */}
                <div className="p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <Package className="w-4 h-4 text-indigo-400" />
                        <span className="text-sm font-semibold text-ink">Data Products</span>
                    </div>
                    <div className="space-y-2">
                        {catalogItems.map(item => (
                            <div key={item.id} className="flex items-center gap-2 text-sm text-ink-muted">
                                <Package className="w-3.5 h-3.5 text-ink-secondary flex-shrink-0" />
                                <span>{item.name}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Workspace Mapping */}
                <div className="p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-emerald-400" />
                        <span className="text-sm font-semibold text-ink">Workspace Mapping</span>
                    </div>
                    <div className="space-y-2">
                        {catalogItems.map(item => {
                            const wsLabel = getWorkspaceLabel(item.id, formData, workspaceNames)
                            const alloc = formData.allocations[item.id]
                            const isNew = alloc?.workspaceId === 'new'
                            return (
                                <div key={item.id} className="flex items-center gap-2 text-sm">
                                    <span className="text-ink-muted">{item.name}</span>
                                    <span className="text-ink-secondary">&rarr;</span>
                                    <span className={cn(
                                        'inline-flex items-center gap-1.5',
                                        isNew ? 'text-emerald-400' : 'text-ink',
                                    )}>
                                        <span className={cn(
                                            'w-2 h-2 rounded-full',
                                            isNew ? 'bg-emerald-400' : 'bg-indigo-400',
                                        )} />
                                        {wsLabel}
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                </div>

                {/* Semantic Layer */}
                <div className="p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <BookOpen className="w-4 h-4 text-amber-400" />
                        <span className="text-sm font-semibold text-ink">Semantic Layer</span>
                    </div>
                    <div className="space-y-2">
                        {catalogItems.map(item => {
                            const ontLabel = getOntologyLabel(item.id, formData, ontologyNames)
                            const pct = getCoveragePct(item.id, formData)
                            return (
                                <div key={item.id} className="flex items-center justify-between text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="text-ink-muted">{item.name}</span>
                                        <span className="text-ink-secondary">&rarr;</span>
                                        <span className="text-ink">{ontLabel}</span>
                                    </div>
                                    {pct !== null && (
                                        <span className={cn(
                                            'text-xs font-medium',
                                            pct >= 70
                                                ? 'text-emerald-400'
                                                : pct >= 40
                                                  ? 'text-amber-400'
                                                  : 'text-red-400',
                                        )}>
                                            {pct}% coverage
                                        </span>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>

                {/* Aggregation */}
                <div className="p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-violet-400" />
                        <span className="text-sm font-semibold text-ink">Aggregation</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-ink-muted">
                        {formData.projectionMode === 'in_source' ? (
                            <>
                                <Database className="w-3.5 h-3.5 text-ink-secondary" />
                                <span>In-source projection (query directly)</span>
                            </>
                        ) : (
                            <>
                                <Zap className="w-3.5 h-3.5 text-ink-secondary" />
                                <span>Dedicated projection graph</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
                <div className="glass-panel-subtle rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-ink">{catalogItems.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-secondary mt-1">
                        Products
                    </div>
                </div>
                <div className="glass-panel-subtle rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-ink">{uniqueWorkspaces.size}</div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-secondary mt-1">
                        Domains
                    </div>
                </div>
                <div className="glass-panel-subtle rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-ink">{uniqueOntologies.size}</div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-secondary mt-1">
                        Ontologies
                    </div>
                </div>
            </div>
        </div>
    )
}

/* ---------- Success Phase ---------- */
function SuccessPhase({
    formData,
    catalogItems,
    onNavigate,
}: Pick<ReviewStepProps, 'formData' | 'catalogItems' | 'onNavigate'>) {
    const [countdown, setCountdown] = useState(15)

    const uniqueWorkspaces = new Set(
        Object.values(formData.allocations)
            .map(a => a.workspaceId)
            .filter(Boolean),
    )

    // Auto-redirect countdown
    useEffect(() => {
        if (countdown <= 0) {
            onNavigate('explore')
            return
        }
        const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
        return () => clearTimeout(timer)
    }, [countdown, onNavigate])

    const ctaCards: Array<{
        key: 'explore' | 'create-view' | 'configure-more'
        label: string
        description: string
        icon: typeof Search
        accent: string
        recommended?: boolean
    }> = [
        {
            key: 'explore',
            label: 'Explore Graph',
            description: 'Browse your newly onboarded data sources',
            icon: Search,
            accent: 'indigo',
            recommended: true,
        },
        {
            key: 'create-view',
            label: 'Create First View',
            description: 'Build a contextual view for your team',
            icon: Sparkles,
            accent: 'emerald',
        },
        {
            key: 'configure-more',
            label: 'Configure More Sources',
            description: 'Onboard additional data products',
            icon: Settings,
            accent: 'slate',
        },
    ]

    return (
        <div className="flex flex-col items-center text-center space-y-8 py-4">
            {/* Animated checkmark */}
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', damping: 15, stiffness: 200 }}
                className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center"
            >
                <Check className="w-8 h-8 text-emerald-500" />
            </motion.div>

            {/* Heading */}
            <div className="space-y-2">
                <motion.h2
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="text-2xl font-bold text-ink"
                >
                    Setup Complete
                </motion.h2>
                <motion.p
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="text-sm text-ink-muted max-w-md"
                >
                    Created {catalogItems.length} data source{catalogItems.length !== 1 ? 's' : ''} across{' '}
                    {uniqueWorkspaces.size} workspace{uniqueWorkspaces.size !== 1 ? 's' : ''} with semantic
                    layer configured
                </motion.p>
            </div>

            {/* CTA cards */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="grid grid-cols-3 gap-4 w-full"
            >
                {ctaCards.map(card => {
                    const Icon = card.icon
                    const accentBg = card.accent === 'indigo'
                        ? 'hover:border-indigo-500/30 hover:bg-indigo-500/5'
                        : card.accent === 'emerald'
                          ? 'hover:border-emerald-500/30 hover:bg-emerald-500/5'
                          : 'hover:border-slate-500/30 hover:bg-slate-500/5'
                    const iconColor = card.accent === 'indigo'
                        ? 'text-indigo-400'
                        : card.accent === 'emerald'
                          ? 'text-emerald-400'
                          : 'text-slate-400'

                    return (
                        <motion.div
                            key={card.key}
                            whileHover={{ y: -3 }}
                            onClick={() => onNavigate(card.key)}
                            className={cn(
                                'glass-panel rounded-xl p-5 cursor-pointer',
                                'border border-glass-border transition-colors duration-150',
                                accentBg,
                                'relative',
                            )}
                        >
                            {card.recommended && (
                                <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-indigo-500/20 text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">
                                    Recommended
                                </span>
                            )}
                            <div className="flex flex-col items-center gap-3">
                                <div className={cn(
                                    'w-10 h-10 rounded-xl flex items-center justify-center',
                                    card.accent === 'indigo'
                                        ? 'bg-indigo-500/10'
                                        : card.accent === 'emerald'
                                          ? 'bg-emerald-500/10'
                                          : 'bg-slate-500/10',
                                )}>
                                    <Icon className={cn('w-5 h-5', iconColor)} />
                                </div>
                                <div>
                                    <div className="text-sm font-semibold text-ink">{card.label}</div>
                                    <div className="text-xs text-ink-muted mt-0.5">{card.description}</div>
                                </div>
                            </div>
                        </motion.div>
                    )
                })}
            </motion.div>

            {/* Countdown bar */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="w-full max-w-xs space-y-2"
            >
                <div className="h-1 rounded-full bg-slate-700/50 overflow-hidden">
                    <motion.div
                        initial={{ width: '100%' }}
                        animate={{ width: '0%' }}
                        transition={{ duration: 15, ease: 'linear' }}
                        className="h-full rounded-full bg-indigo-500"
                    />
                </div>
                <p className="text-xs text-ink-secondary">
                    Auto-redirect in {countdown}s
                </p>
            </motion.div>
        </div>
    )
}

/* ---------- Main Export ---------- */
export function ReviewStep(props: ReviewStepProps) {
    return (
        <AnimatePresence mode="wait">
            {props.phase === 'review' ? (
                <motion.div
                    key="review"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                >
                    <ReviewPhase
                        formData={props.formData}
                        catalogItems={props.catalogItems}
                        workspaceNames={props.workspaceNames}
                        ontologyNames={props.ontologyNames}
                    />
                </motion.div>
            ) : (
                <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                >
                    <SuccessPhase
                        formData={props.formData}
                        catalogItems={props.catalogItems}
                        onNavigate={props.onNavigate}
                    />
                </motion.div>
            )}
        </AnimatePresence>
    )
}
