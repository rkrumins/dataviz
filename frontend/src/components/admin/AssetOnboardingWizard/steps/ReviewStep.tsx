/**
 * ReviewStep — Final review summary and animated success screen for the onboarding wizard.
 *
 * Review phase: structured summary with mini workspace preview cards.
 * Success phase: celebration animation, live aggregation progress,
 * 5 CTA navigation cards, countdown with hover-pause, dismiss option.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Check, Package, Database, BookOpen, Compass, Sparkles,
    Zap, Plus, Activity, Loader2, CheckCircle2, Clock, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CatalogItemResponse } from '@/services/catalogService'
import { aggregationService, type AggregationJobResponse } from '@/services/aggregationService'
import type { OnboardingFormData } from '../AssetOnboardingWizard'

// ─── Types ───────────────────────────────────────────────────────────────────

export type NavigationDestination = 'explorer' | 'schema' | 'configure-more' | 'aggregation-jobs' | 'workspaces' | 'dismiss'

interface ReviewStepProps {
    formData: OnboardingFormData
    catalogItems: CatalogItemResponse[]
    phase: 'review' | 'success'
    onNavigate: (destination: NavigationDestination) => void
    workspaceNames: Record<string, string>
    ontologyNames: Record<string, string>
    /** Data source IDs created during onboarding — used for live aggregation tracking */
    createdDataSourceIds?: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    // Total graph types = covered + uncovered (same formula as SemanticStep's CoverageRing)
    const entityTotal = (stats.coveredEntityTypes?.length ?? 0) + (stats.uncoveredEntityTypes?.length ?? 0)
    const relTotal = (stats.coveredRelationshipTypes?.length ?? 0) + (stats.uncoveredRelationshipTypes?.length ?? 0)
    const totalAll = entityTotal + relTotal
    if (totalAll === 0) return null
    const totalCovered = (stats.coveredEntityTypes?.length ?? 0) + (stats.coveredRelationshipTypes?.length ?? 0)
    return Math.round((totalCovered / totalAll) * 100)
}

// ─── CSS-only Confetti ───────────────────────────────────────────────────────

const CONFETTI_STYLE = `
@keyframes confetti-fall {
  0% { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
  100% { transform: translate(var(--cx), var(--cy)) rotate(var(--cr)) scale(0); opacity: 0; }
}
.confetti-piece {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 1px;
  animation: confetti-fall 1.2s ease-out forwards;
  animation-delay: var(--cd);
}
`

function ConfettiBurst() {
    const colors = ['#6366f1', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4']
    const pieces = Array.from({ length: 24 }, (_, i) => {
        const angle = (i / 24) * 360
        const distance = 60 + Math.random() * 80
        const rad = (angle * Math.PI) / 180
        return {
            key: i,
            color: colors[i % colors.length],
            cx: `${Math.cos(rad) * distance}px`,
            cy: `${Math.sin(rad) * distance - 40}px`,
            cr: `${Math.random() * 720 - 360}deg`,
            cd: `${Math.random() * 0.3}s`,
            size: 4 + Math.random() * 4,
            round: Math.random() > 0.5,
        }
    })

    return (
        <>
            <style>{CONFETTI_STYLE}</style>
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                {pieces.map(p => (
                    <div
                        key={p.key}
                        className="confetti-piece"
                        style={{
                            '--cx': p.cx,
                            '--cy': p.cy,
                            '--cr': p.cr,
                            '--cd': p.cd,
                            width: p.size,
                            height: p.size,
                            backgroundColor: p.color,
                            borderRadius: p.round ? '50%' : '1px',
                        } as React.CSSProperties}
                    />
                ))}
            </div>
        </>
    )
}

// ─── Review Phase ────────────────────────────────────────────────────────────
// Aligned with ViewWizard PreviewStep: centered header pill, gradient card
// with divide-y sections, icon boxes, check marks, congratulatory CTA.

function ReviewPhase({
    formData,
    catalogItems,
    workspaceNames,
    ontologyNames,
}: Omit<ReviewStepProps, 'phase' | 'onNavigate' | 'createdDataSourceIds'>) {
    return (
        <div className="max-w-2xl mx-auto space-y-8">
            {/* Header — matches ViewWizard PreviewStep */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center"
            >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm font-medium mb-4">
                    <Sparkles className="w-4 h-4" />
                    Ready to onboard
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
                    Review your configuration
                </h3>
                <p className="text-slate-500">
                    Everything looks great — here's a summary of what will be set up
                </p>
            </motion.div>

            {/* Configuration Card — ViewWizard gradient card pattern */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="bg-gradient-to-br from-slate-50 to-white dark:from-slate-800 dark:to-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
            >
                <div className="divide-y divide-slate-200 dark:divide-slate-700">
                    {/* Data Sources */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                                <Package className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Data Sources</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">{catalogItems.length} source{catalogItems.length !== 1 ? 's' : ''} to onboard</p>
                            </div>
                            <Check className="w-5 h-5 text-green-500" />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            {catalogItems.map(item => (
                                <span
                                    key={item.id}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm"
                                >
                                    <Package className="w-3 h-3 text-indigo-400" />
                                    {item.name}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Workspace Mapping */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <Database className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Workspace Mapping</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">
                                    {new Set(Object.values(formData.allocations).map(a => a.workspaceId).filter(Boolean)).size} workspace{new Set(Object.values(formData.allocations).map(a => a.workspaceId).filter(Boolean)).size !== 1 ? 's' : ''}
                                </p>
                            </div>
                            <Check className="w-5 h-5 text-green-500" />
                        </div>
                        <div className="space-y-2">
                            {catalogItems.map(item => {
                                const wsLabel = getWorkspaceLabel(item.id, formData, workspaceNames)
                                const alloc = formData.allocations[item.id]
                                const isNew = alloc?.workspaceId === 'new'
                                return (
                                    <div key={item.id} className="flex items-center gap-2 text-sm">
                                        <span className="text-slate-500">{item.name}</span>
                                        <span className="text-slate-400">&rarr;</span>
                                        <span className={cn(
                                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm border',
                                            isNew
                                                ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-400'
                                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200',
                                        )}>
                                            <span className={cn(
                                                'w-2 h-2 rounded-full',
                                                isNew ? 'bg-emerald-500' : 'bg-indigo-500',
                                            )} />
                                            {wsLabel}
                                            {isNew && <span className="text-[10px] font-bold text-emerald-500 uppercase">New</span>}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Semantic Layer */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                                <BookOpen className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Semantic Layer</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">
                                    {Object.values(formData.ontologySelections).filter(s => s.ontologyId).length} ontolog{Object.values(formData.ontologySelections).filter(s => s.ontologyId).length !== 1 ? 'ies' : 'y'} assigned
                                </p>
                            </div>
                            <Check className="w-5 h-5 text-green-500" />
                        </div>
                        <div className="space-y-2">
                            {catalogItems.map(item => {
                                const ontLabel = getOntologyLabel(item.id, formData, ontologyNames)
                                const pct = getCoveragePct(item.id, formData)
                                return (
                                    <div key={item.id} className="flex items-center justify-between text-sm">
                                        <div className="flex items-center gap-2">
                                            <span className="text-slate-500">{item.name}</span>
                                            <span className="text-slate-400">&rarr;</span>
                                            <span className="font-medium text-slate-800 dark:text-slate-200">{ontLabel}</span>
                                        </div>
                                        {pct !== null && (
                                            <span className={cn(
                                                'text-xs font-semibold px-2 py-0.5 rounded-full',
                                                pct >= 70
                                                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                                                    : pct >= 40
                                                      ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'
                                                      : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400',
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
                    <div className="p-5 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-400">
                            <Zap className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Aggregation</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200">
                                {formData.projectionMode === 'in_source'
                                    ? 'In-source projection'
                                    : formData.projectionMode === 'dedicated'
                                        ? `Dedicated projection graph${formData.dedicatedGraphName ? ` (${formData.dedicatedGraphName})` : ''}`
                                        : 'Aggregation skipped (can be enabled later)'}
                            </p>
                            {formData.projectionMode === 'dedicated' && (
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Strategy: {formData.dedicatedStrategy === 'full_copy' ? 'Full Copy' : 'Containment Only'}
                                </p>
                            )}
                        </div>
                        <Check className="w-5 h-5 text-green-500" />
                    </div>
                </div>
            </motion.div>

            {/* Confirmation CTA — matches ViewWizard */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="text-center text-slate-500 text-sm"
            >
                Click <strong className="text-slate-700 dark:text-slate-300">"Complete Setup"</strong> to onboard your data sources and start aggregation
            </motion.div>
        </div>
    )
}

// ─── Success Phase ───────────────────────────────────────────────────────────

function SuccessPhase({
    formData,
    catalogItems,
    onNavigate,
    createdDataSourceIds,
}: Pick<ReviewStepProps, 'formData' | 'catalogItems' | 'onNavigate' | 'createdDataSourceIds'>) {
    const [countdown, setCountdown] = useState(15)
    const [isPaused, setIsPaused] = useState(false)
    const [aggJobs, setAggJobs] = useState<AggregationJobResponse[]>([])
    const countdownRef = useRef(countdown)
    countdownRef.current = countdown

    const uniqueWorkspaces = new Set(
        Object.values(formData.allocations).map(a => a.workspaceId).filter(Boolean),
    )

    // Auto-redirect countdown (with hover-pause)
    useEffect(() => {
        if (isPaused || countdown <= 0) {
            if (countdown <= 0) onNavigate('explorer')
            return
        }
        const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
        return () => clearTimeout(timer)
    }, [countdown, isPaused, onNavigate])

    // Cancel countdown when user clicks any CTA
    const handleNavigate = useCallback((dest: NavigationDestination) => {
        setCountdown(-1) // prevent auto-redirect
        onNavigate(dest)
    }, [onNavigate])

    // Poll aggregation jobs for live progress
    useEffect(() => {
        if (!createdDataSourceIds || createdDataSourceIds.length === 0) return

        let cancelled = false
        const poll = async () => {
            try {
                const allJobs = await Promise.all(
                    createdDataSourceIds.map(dsId => aggregationService.listJobs(dsId))
                )
                if (!cancelled) setAggJobs(allJobs.flat())
            } catch {
                // Silently ignore — this is best-effort
            }
        }

        poll()
        const interval = setInterval(poll, 3000)
        return () => {
            cancelled = true
            clearInterval(interval)
        }
    }, [createdDataSourceIds])

    const allJobsComplete = aggJobs.length > 0 && aggJobs.every(j => j.status === 'completed')

    // CTA card definitions
    const primaryCards: Array<{
        key: NavigationDestination
        label: string
        description: string
        icon: typeof Compass
        accent: string
        recommended?: boolean
    }> = [
        {
            key: 'explorer',
            label: 'Go to Explorer',
            description: 'Browse your newly onboarded data',
            icon: Compass,
            accent: 'indigo',
            recommended: true,
        },
        {
            key: 'schema',
            label: 'Examine Schema',
            description: 'Review ontology and type definitions',
            icon: BookOpen,
            accent: 'emerald',
        },
    ]

    const secondaryCards: typeof primaryCards = [
        {
            key: 'aggregation-jobs',
            label: 'Aggregation Progress',
            description: 'Monitor running aggregation jobs',
            icon: Activity,
            accent: 'violet',
        },
        {
            key: 'configure-more',
            label: 'Configure More Sources',
            description: 'Onboard additional data sources',
            icon: Plus,
            accent: 'slate',
        },
        {
            key: 'workspaces',
            label: 'Go to Workspaces',
            description: 'Manage workspace settings',
            icon: Database,
            accent: 'slate',
        },
    ]

    const accentClasses: Record<string, { hover: string; icon: string; bg: string }> = {
        indigo: {
            hover: 'hover:border-indigo-500/30 hover:bg-indigo-500/5',
            icon: 'text-indigo-400',
            bg: 'bg-indigo-500/10',
        },
        emerald: {
            hover: 'hover:border-emerald-500/30 hover:bg-emerald-500/5',
            icon: 'text-emerald-400',
            bg: 'bg-emerald-500/10',
        },
        violet: {
            hover: 'hover:border-violet-500/30 hover:bg-violet-500/5',
            icon: 'text-violet-400',
            bg: 'bg-violet-500/10',
        },
        slate: {
            hover: 'hover:border-slate-500/30 hover:bg-slate-500/5',
            icon: 'text-slate-400',
            bg: 'bg-slate-500/10',
        },
    }

    return (
        <div className="flex flex-col items-center text-center space-y-7 py-2">
            {/* Celebration — checkmark with confetti */}
            <div className="relative">
                <ConfettiBurst />
                <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', damping: 12, stiffness: 180 }}
                    className="relative w-20 h-20 rounded-full flex items-center justify-center"
                >
                    {/* Ambient glow */}
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/20 to-emerald-500/20 blur-xl animate-pulse" />
                    <div className="relative w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                        <Check className="w-8 h-8 text-emerald-500" />
                    </div>
                </motion.div>
            </div>

            {/* Heading */}
            <div className="space-y-2">
                <motion.h2
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 }}
                    className="text-2xl font-bold text-ink"
                >
                    Setup Complete
                </motion.h2>
                <motion.p
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 }}
                    className="text-sm text-ink-muted max-w-md"
                >
                    Created {catalogItems.length} data source{catalogItems.length !== 1 ? 's' : ''} across{' '}
                    {uniqueWorkspaces.size} workspace{uniqueWorkspaces.size !== 1 ? 's' : ''} with semantic
                    layer configured
                </motion.p>
            </div>

            {/* Live Aggregation Progress */}
            {aggJobs.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 }}
                    className="w-full max-w-md"
                >
                    <div className="glass-panel rounded-xl p-4 space-y-3 text-left">
                        <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4 text-violet-400" />
                            <span className="text-xs font-semibold text-ink">Aggregation Progress</span>
                            {allJobsComplete && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 ml-auto">
                                    <CheckCircle2 className="w-2.5 h-2.5" /> All complete
                                </span>
                            )}
                        </div>
                        <div className="space-y-2">
                            {aggJobs.map(job => {
                                const progressPct = Math.round((job.progress || 0) * 100)
                                let StatusIcon: typeof CheckCircle2
                                let statusColor: string
                                switch (job.status) {
                                    case 'completed': StatusIcon = CheckCircle2; statusColor = 'text-emerald-500'; break
                                    case 'failed': StatusIcon = AlertCircle; statusColor = 'text-red-500'; break
                                    case 'running': StatusIcon = Loader2; statusColor = 'text-indigo-500'; break
                                    default: StatusIcon = Clock; statusColor = 'text-amber-500'
                                }
                                return (
                                    <div key={job.id} className="flex items-center gap-2.5">
                                        <StatusIcon className={cn('w-3.5 h-3.5 flex-shrink-0', statusColor, job.status === 'running' && 'animate-spin')} />
                                        <div className="flex-1 min-w-0">
                                            {job.status === 'running' ? (
                                                <div className="flex items-center gap-2">
                                                    <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                                                        <div
                                                            className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                                                            style={{ width: `${progressPct}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-[10px] font-bold text-indigo-500 w-8 text-right">{progressPct}%</span>
                                                </div>
                                            ) : (
                                                <span className={cn('text-[11px] font-medium', statusColor)}>
                                                    {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-[9px] text-ink-muted font-mono flex-shrink-0">
                                            {job.id.slice(-6)}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Primary CTA cards */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="grid grid-cols-2 gap-4 w-full"
                onMouseEnter={() => setIsPaused(true)}
                onMouseLeave={() => setIsPaused(false)}
            >
                {primaryCards.map(card => {
                    const Icon = card.icon
                    const styles = accentClasses[card.accent]
                    return (
                        <motion.div
                            key={card.key}
                            whileHover={{ y: -3 }}
                            onClick={() => handleNavigate(card.key)}
                            className={cn(
                                'glass-panel rounded-xl p-5 cursor-pointer relative',
                                'border border-glass-border transition-colors duration-150',
                                styles.hover,
                            )}
                        >
                            {card.recommended && (
                                <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-indigo-500/20 text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">
                                    Recommended
                                </span>
                            )}
                            <div className="flex flex-col items-center gap-3">
                                <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', styles.bg)}>
                                    <Icon className={cn('w-5 h-5', styles.icon)} />
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

            {/* Secondary CTA cards */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="grid grid-cols-3 gap-3 w-full"
                onMouseEnter={() => setIsPaused(true)}
                onMouseLeave={() => setIsPaused(false)}
            >
                {secondaryCards.map(card => {
                    const Icon = card.icon
                    const styles = accentClasses[card.accent]
                    return (
                        <button
                            key={card.key}
                            onClick={() => handleNavigate(card.key)}
                            className={cn(
                                'glass-panel-subtle rounded-xl p-3.5 text-center cursor-pointer',
                                'border border-glass-border transition-colors duration-150',
                                styles.hover,
                            )}
                        >
                            <div className="flex flex-col items-center gap-2">
                                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', styles.bg)}>
                                    <Icon className={cn('w-4 h-4', styles.icon)} />
                                </div>
                                <div className="text-xs font-medium text-ink">{card.label}</div>
                            </div>
                        </button>
                    )
                })}
            </motion.div>

            {/* "Stay on this page" dismiss */}
            <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                onClick={() => handleNavigate('dismiss')}
                className="text-xs text-ink-muted hover:text-ink-secondary transition-colors"
            >
                Stay on this page
            </motion.button>

            {/* Countdown bar */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="w-full max-w-xs space-y-2"
            >
                <div className="h-1 rounded-full bg-slate-700/50 overflow-hidden">
                    <motion.div
                        initial={{ width: '100%' }}
                        animate={{ width: isPaused ? undefined : '0%' }}
                        transition={isPaused ? undefined : { duration: 15, ease: 'linear' }}
                        className="h-full rounded-full bg-indigo-500"
                        style={isPaused ? { width: `${(countdown / 15) * 100}%` } : undefined}
                    />
                </div>
                <p className="text-xs text-ink-secondary">
                    {isPaused ? 'Auto-redirect paused' : `Auto-redirect in ${countdown}s`}
                </p>
            </motion.div>
        </div>
    )
}

// ─── Main Export ──────────────────────────────────────────────────────────────

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
                        createdDataSourceIds={props.createdDataSourceIds}
                    />
                </motion.div>
            )}
        </AnimatePresence>
    )
}
