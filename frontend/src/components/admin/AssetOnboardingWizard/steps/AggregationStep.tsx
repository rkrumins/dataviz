/**
 * AggregationStep - Choose projection / aggregation strategy
 *
 * Presents three options: "In-Source" (write aggregated edges back to the
 * physical graph), "Dedicated Graph" (sync to a separate cache graph), or
 * "Skip for Now" (defer aggregation entirely).
 *
 * Includes:
 * - Enhanced descriptions explaining why each mode matters
 * - Dedicated graph sub-configuration (strategy + graph name)
 * - Skip warning with performance impact and opt-in-later guidance
 * - Collapsible advanced configuration (batch size, retries, timeout)
 * - Mode switching guidance for post-onboarding changes
 * - Track Progress reference to the Ingestion page
 */

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Settings, Check, AlertTriangle, Clock, Loader2, CheckCircle2,
    Activity, SkipForward, Copy, GitBranch, Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OnboardingFormData } from '../AssetOnboardingWizard'
import type { CatalogItemResponse } from '@/services/catalogService'
import {
    AggregationOverridesForm,
    type AggregationOverridesValue,
} from '../../shared/AggregationOverridesForm'

// ============================================
// Types
// ============================================

interface AggregationStepProps {
    formData: OnboardingFormData
    updateFormData: (updates: Partial<OnboardingFormData> | ((prev: OnboardingFormData) => Partial<OnboardingFormData>)) => void
    catalogItems: CatalogItemResponse[]
}

// ============================================
// Option Definitions
// ============================================

interface OptionDef {
    id: OnboardingFormData['projectionMode']
    title: string
    subtitle: string
    recommended?: boolean
    pros: string[]
    cons: string[]
}

const OPTIONS: OptionDef[] = [
    {
        id: 'in_source',
        title: 'In-Source',
        subtitle: 'Write aggregated edges directly into the physical graph. Queries read from a single unified graph with zero additional latency.',
        recommended: true,
        pros: [
            'Zero query latency — reads from the live graph',
            'Single source of truth — no sync required',
        ],
        cons: [
            'Shared mutations — aggregated edges co-exist with raw data',
        ],
    },
    {
        id: 'dedicated',
        title: 'Dedicated Graph',
        subtitle: 'Project aggregated relationships to an isolated cache graph. Source data stays untouched, enabling safe experimentation.',
        pros: [
            'Full isolation — source graph is never modified',
            'Independent scaling — cache graph optimized separately',
        ],
        cons: [
            'Sync delay — dedicated graph lags behind source mutations',
        ],
    },
    {
        id: 'skip',
        title: 'Skip for Now',
        subtitle: 'Defer aggregation — proceed without pre-computing hierarchical relationships.',
        pros: [
            'Fastest onboarding',
            'No compute overhead',
        ],
        cons: [
            'Slower queries on large graphs',
            'No indirect relationship tracing',
        ],
    },
]

// ============================================
// formData <-> AggregationOverridesValue bridge
// ============================================

/**
 * The wizard's `advancedConfig.timeoutMinutes` is `number | null` (null = 2hr
 * default). The shared form requires a concrete `number`. We materialise null
 * as 120 (the documented 2hr default) when handing to the form, and pass the
 * form's number straight back into `formData` (no longer null).
 */
const TIMEOUT_DEFAULT_MINUTES = 120

// ============================================
// Component
// ============================================

export function AggregationStep({ formData, updateFormData, catalogItems }: AggregationStepProps) {
    const selected = formData.projectionMode

    // Auto-populate dedicated graph name when switching to dedicated mode
    useEffect(() => {
        if (selected === 'dedicated' && !formData.dedicatedGraphName) {
            const baseName = catalogItems[0]?.name || catalogItems[0]?.sourceIdentifier || 'source'
            const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
            updateFormData({ dedicatedGraphName: `${safeName}_aggregated` })
        }
    }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

    // Bridge formData.advancedConfig <-> AggregationOverridesValue.
    // The shared form needs a concrete number for timeoutMinutes; we surface the
    // documented 2hr default when the wizard's value is null, and write back as
    // a concrete number on every edit. projectionMode in the shared form is
    // 'in_source' | 'dedicated' only — when the wizard is in 'skip', the form
    // is not rendered, so we feed any valid placeholder.
    const overridesValue: AggregationOverridesValue = {
        batchSize: formData.advancedConfig.batchSize,
        maxRetries: formData.advancedConfig.maxRetries,
        timeoutMinutes: formData.advancedConfig.timeoutMinutes ?? TIMEOUT_DEFAULT_MINUTES,
        projectionMode: selected === 'dedicated' ? 'dedicated' : 'in_source',
    }

    const handleOverridesChange = (next: AggregationOverridesValue) => {
        updateFormData({
            advancedConfig: {
                batchSize: next.batchSize,
                maxRetries: next.maxRetries,
                timeoutMinutes: next.timeoutMinutes,
            },
        })
    }

    return (
        <div className="space-y-5">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3"
            >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                    <Settings className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-ink">Aggregation Strategy</h3>
                    <p className="text-sm text-ink-muted mt-0.5">
                        Choose how aggregated relationships are projected across your data sources.
                        This affects query performance, data isolation, and write semantics.
                    </p>
                </div>
            </motion.div>

            {/* Contextual source count callout */}
            {catalogItems.length > 1 && (
                <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 }}
                    className="flex items-start gap-2.5 px-4 py-3 rounded-xl border border-indigo-500/15 bg-indigo-500/[0.03]"
                >
                    <Info className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-ink-secondary leading-relaxed">
                        Configuring aggregation for <strong className="text-ink">{catalogItems.length} data sources</strong>.
                        This strategy applies to all sources in this batch. You can customize per-source after onboarding.
                    </p>
                </motion.div>
            )}

            {/* Option Cards — 3-column grid */}
            <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Aggregation strategy">
                {OPTIONS.map((option, index) => {
                    const isSelected = selected === option.id

                    return (
                        <motion.button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            initial={{ opacity: 0, y: 15 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: Math.min(index * 0.01, 0.05) }}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => updateFormData({ projectionMode: option.id })}
                            className={cn(
                                'glass-panel rounded-2xl border p-4 text-left cursor-pointer transition-all',
                                isSelected
                                    ? 'border-indigo-500/40 bg-indigo-500/5 shadow-lg shadow-indigo-500/10'
                                    : 'border-glass-border hover:border-indigo-500/20'
                            )}
                        >
                            {/* Title Row */}
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className={cn(
                                    'text-sm font-semibold',
                                    isSelected ? 'text-indigo-400' : 'text-ink'
                                )}>
                                    {option.title}
                                </h4>
                                {option.recommended && (
                                    <span className="bg-indigo-500/10 text-indigo-500 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full">
                                        Recommended
                                    </span>
                                )}
                            </div>

                            <p className="text-[11px] text-ink-muted mb-3 leading-relaxed line-clamp-3">
                                {option.subtitle}
                            </p>

                            {/* Pros */}
                            <div className="space-y-1 mb-2">
                                {option.pros.map(pro => (
                                    <div key={pro} className="flex items-start gap-1.5">
                                        <Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" />
                                        <span className="text-[11px] text-emerald-400 leading-tight">{pro}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Cons */}
                            <div className="space-y-1">
                                {option.cons.map(con => (
                                    <div key={con} className="flex items-start gap-1.5">
                                        <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                                        <span className="text-[11px] text-amber-400 leading-tight">{con}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Selection Indicator */}
                            <div className={cn(
                                'mt-3 pt-2.5 border-t flex items-center justify-center gap-2 text-xs font-medium transition-all',
                                isSelected
                                    ? 'border-indigo-500/20 text-indigo-400'
                                    : 'border-glass-border text-ink-muted'
                            )}>
                                <div className={cn(
                                    'w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all',
                                    isSelected
                                        ? 'border-indigo-500 bg-indigo-500'
                                        : 'border-glass-border'
                                )}>
                                    {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                </div>
                                {isSelected ? 'Selected' : 'Select'}
                            </div>
                        </motion.button>
                    )
                })}
            </div>

            {/* ─── Skip Warning ─────────────────────────────────────────────── */}
            <AnimatePresence>
                {selected === 'skip' && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.12 }}
                        className="overflow-hidden"
                    >
                        <div className="space-y-3">
                            {/* Performance warning */}
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 flex items-start gap-3">
                                <SkipForward className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                                <div>
                                    <h4 className="text-sm font-semibold text-amber-400">Performance Impact Warning</h4>
                                    <p className="text-xs text-amber-400/80 mt-1 leading-relaxed">
                                        Skipping aggregation means the system will not pre-compute hierarchical relationships.
                                        For large graphs (10,000+ nodes), this can cause significantly slower queries when
                                        tracing indirect relationships across containment hierarchies — operations that would
                                        normally complete in milliseconds may take seconds.
                                    </p>
                                </div>
                            </div>

                            {/* Opt-in-later reassurance */}
                            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex items-start gap-3">
                                <Info className="w-5 h-5 text-indigo-500 mt-0.5 flex-shrink-0" />
                                <div>
                                    <h4 className="text-sm font-semibold text-ink">You can enable aggregation later</h4>
                                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                                        Navigate to your Workspace, select the Data Source, and use the <strong className="text-ink-secondary">Aggregation</strong> tab
                                        to choose a strategy and trigger the job at any time. You can also trigger it from
                                        the <strong className="text-ink-secondary">Ingestion &gt; Job History</strong> page.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ─── Dedicated Graph Configuration ────────────────────────────── */}
            <AnimatePresence>
                {selected === 'dedicated' && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.12 }}
                        className="overflow-hidden"
                    >
                        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-4">
                            <h4 className="text-sm font-semibold text-ink flex items-center gap-2">
                                <Settings className="w-4 h-4 text-indigo-500" />
                                Dedicated Graph Configuration
                            </h4>

                            {/* Strategy sub-options */}
                            <div>
                                <label className="block text-[11px] font-medium text-ink-secondary mb-2 uppercase tracking-wider">
                                    Copy Strategy
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => updateFormData({ dedicatedStrategy: 'full_copy' })}
                                        className={cn(
                                            'rounded-xl border p-3 text-left transition-all',
                                            formData.dedicatedStrategy === 'full_copy'
                                                ? 'border-indigo-500/40 bg-indigo-500/10'
                                                : 'border-glass-border hover:border-indigo-500/20'
                                        )}
                                    >
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <Copy className="w-3.5 h-3.5 text-indigo-500" />
                                            <span className={cn(
                                                'text-xs font-semibold',
                                                formData.dedicatedStrategy === 'full_copy' ? 'text-indigo-400' : 'text-ink'
                                            )}>
                                                Full Copy
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-ink-muted leading-relaxed">
                                            Complete copy of the source graph. All nodes, edges, and properties preserved.
                                            Aggregations run against the copy.
                                        </p>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => updateFormData({ dedicatedStrategy: 'containment_only' })}
                                        className={cn(
                                            'rounded-xl border p-3 text-left transition-all',
                                            formData.dedicatedStrategy === 'containment_only'
                                                ? 'border-indigo-500/40 bg-indigo-500/10'
                                                : 'border-glass-border hover:border-indigo-500/20'
                                        )}
                                    >
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                                            <span className={cn(
                                                'text-xs font-semibold',
                                                formData.dedicatedStrategy === 'containment_only' ? 'text-indigo-400' : 'text-ink'
                                            )}>
                                                Containment Only
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-ink-muted leading-relaxed">
                                            Preserve only nodes and containment edges. Create only aggregated edges.
                                            Minimal graph optimized for hierarchy queries.
                                        </p>
                                    </button>
                                </div>
                            </div>

                            {/* Graph Name */}
                            <div>
                                <label className="block text-[11px] font-medium text-ink-secondary mb-1.5 uppercase tracking-wider">
                                    Dedicated Graph Name
                                </label>
                                <input
                                    type="text"
                                    value={formData.dedicatedGraphName}
                                    onChange={e => updateFormData({ dedicatedGraphName: e.target.value })}
                                    placeholder={`e.g. ${(catalogItems[0]?.name || 'source').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_aggregated`}
                                    className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink placeholder:text-ink-muted/50 outline-none transition-all focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border"
                                />
                                <p className="text-[10px] text-ink-muted mt-1.5 flex items-center gap-1.5">
                                    <Info className="w-3 h-3 text-indigo-500/60" />
                                    The dedicated graph will be linked to the original source, preserving lineage tracing across both.
                                </p>
                            </div>

                            {/* Reconciliation & Purge Notes */}
                            <div className="space-y-2 pt-2 border-t border-indigo-500/10">
                                <div className="flex items-start gap-2">
                                    <Activity className="w-3.5 h-3.5 text-violet-500 flex-shrink-0 mt-0.5" />
                                    <p className="text-[11px] text-ink-muted leading-relaxed">
                                        <strong className="text-ink-secondary">Drift detection:</strong> When the source graph changes, the system detects structural drift
                                        and prompts you to re-aggregate. This keeps the dedicated graph in sync without automatic mutations.
                                    </p>
                                </div>
                                <div className="flex items-start gap-2">
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                                    <p className="text-[11px] text-ink-muted leading-relaxed">
                                        <strong className="text-ink-secondary">Purging edges</strong> removes only the aggregated edges from the dedicated graph — the source graph is never touched.
                                        Switching from dedicated to in-source mode requires purging first, then re-triggering aggregation.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ─── Mode Switching Guidance ───────────────────────────────────── */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]"
            >
                <Info className="w-4 h-4 text-ink-muted flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    You can change your aggregation strategy at any time from the Data Source's <strong className="text-ink-secondary">Aggregation</strong> tab.
                    Switching modes requires purging existing aggregated edges before re-triggering with the new strategy.
                </p>
            </motion.div>

            {/* ─── Fine-Tune Performance (hidden when skip) ─────────────────── */}
            <AnimatePresence>
                {selected !== 'skip' && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.12 }}
                        className="overflow-hidden"
                    >
                        <AggregationOverridesForm
                            value={overridesValue}
                            onChange={handleOverridesChange}
                            hideProjectionMode
                        />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ─── Background Aggregation Info (hidden when skip) ─────────────── */}
            <AnimatePresence>
                {selected !== 'skip' && (
                    <motion.div
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ delay: 0.05 }}
                        className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden"
                    >
                        {/* Section 1 — What happens */}
                        <div className="px-4 py-3 flex items-start gap-3">
                            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0 mt-0.5">
                                <Settings className="w-4 h-4 text-indigo-500" />
                            </div>
                            <div>
                                <h4 className="text-sm font-semibold text-ink">Background Aggregation</h4>
                                <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
                                    Graph aggregation pre-computes hierarchical topology to optimize deep graph queries.
                                    This process runs safely in the background after onboarding completes.
                                    You'll be able to create Views once aggregation reaches 100%.
                                </p>
                            </div>
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-indigo-500/10 mx-4" />

                        {/* Section 2 — Track Progress */}
                        <div className="px-4 py-3 flex items-start gap-3">
                            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0 mt-0.5">
                                <Activity className="w-4 h-4 text-violet-500" />
                            </div>
                            <div>
                                <h4 className="text-sm font-semibold text-ink">Track Progress</h4>
                                <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
                                    Monitor aggregation in detail from the <strong className="text-ink-secondary">Ingestion &gt; Job History</strong> page.
                                    Per-source progress is also visible in each Data Source's detail panel.
                                </p>

                                {/* Mini status pill preview */}
                                <div className="flex items-center gap-3 mt-2.5">
                                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
                                        <Clock className="w-3 h-3 text-amber-500" />
                                        <span className="text-[10px] font-semibold text-amber-500">Pending</span>
                                    </div>
                                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20">
                                        <Loader2 className="w-3 h-3 text-indigo-500 animate-spin" />
                                        <span className="text-[10px] font-semibold text-indigo-500">Running</span>
                                    </div>
                                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                        <span className="text-[10px] font-semibold text-emerald-500">Completed</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

export default AggregationStep
