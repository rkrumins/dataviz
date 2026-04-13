/**
 * AggregationStep - Choose projection / aggregation strategy
 *
 * Presents two options: "In-Source" (write aggregated edges back to the
 * physical graph) or "Dedicated Graph" (sync to a separate cache graph).
 * Each option lists pros and cons. Includes reference to the Admin Console
 * Jobs dashboard for monitoring progress post-onboarding.
 */

import { motion } from 'framer-motion'
import { Settings, Check, AlertTriangle, Clock, Loader2, CheckCircle2, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OnboardingFormData } from '../AssetOnboardingWizard'

// ============================================
// Types
// ============================================

interface AggregationStepProps {
    formData: OnboardingFormData
    updateFormData: (updates: Partial<OnboardingFormData>) => void
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
        subtitle: 'Write aggregated edges back to the physical graph',
        recommended: true,
        pros: ['Zero latency', 'Single source of truth'],
        cons: ['Shared mutations'],
    },
    {
        id: 'dedicated',
        title: 'Dedicated Graph',
        subtitle: 'Sync to a separate cache graph for full isolation',
        recommended: false,
        pros: ['Full isolation', 'Independent scaling'],
        cons: ['Sync delay'],
    },
]

// ============================================
// Component
// ============================================

export function AggregationStep({ formData, updateFormData }: AggregationStepProps) {
    const selected = formData.projectionMode

    return (
        <div className="space-y-6">
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
                        This affects latency, isolation, and write semantics.
                    </p>
                </div>
            </motion.div>

            {/* Option Cards */}
            <div className="grid grid-cols-2 gap-4">
                {OPTIONS.map((option, index) => {
                    const isSelected = selected === option.id

                    return (
                        <motion.button
                            key={option.id}
                            type="button"
                            initial={{ opacity: 0, y: 15 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 + index * 0.08 }}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => updateFormData({ projectionMode: option.id })}
                            className={cn(
                                'glass-panel rounded-2xl border p-5 text-left cursor-pointer transition-all',
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
                                    <span className="bg-indigo-500/10 text-indigo-500 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full">
                                        Recommended
                                    </span>
                                )}
                            </div>

                            <p className="text-xs text-ink-muted mb-4 leading-relaxed">
                                {option.subtitle}
                            </p>

                            {/* Pros */}
                            <div className="space-y-1.5 mb-3">
                                {option.pros.map(pro => (
                                    <div key={pro} className="flex items-center gap-2">
                                        <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                                        <span className="text-xs text-emerald-400">{pro}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Cons */}
                            <div className="space-y-1.5">
                                {option.cons.map(con => (
                                    <div key={con} className="flex items-center gap-2">
                                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                                        <span className="text-xs text-amber-400">{con}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Selection Indicator */}
                            <div className={cn(
                                'mt-4 pt-3 border-t flex items-center justify-center gap-2 text-xs font-medium transition-all',
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

            {/* Background Aggregation Info */}
            <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden"
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
                            Monitor aggregation in detail from the <strong className="text-ink-secondary">Admin Console &gt; Jobs</strong> dashboard.
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
        </div>
    )
}

export default AggregationStep
