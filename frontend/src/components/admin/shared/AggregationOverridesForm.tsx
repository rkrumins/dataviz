/**
 * AggregationOverridesForm - Shared, controlled form for aggregation overrides.
 *
 * Extracted from `AssetOnboardingWizard/steps/AggregationStep.tsx` so it can be
 * reused in the "Re-trigger with overrides" dialog. The component is purely
 * controlled: the parent owns `value`, and the component emits `onChange(next)`
 * with a fully-formed value on every edit. Only UI-only state (`showAdvanced`)
 * lives inside the component.
 *
 * Bounds: batchSize 100..50,000, maxRetries 0..10, timeoutMinutes 1..1440.
 * Out-of-range values are clamped on blur (live keystrokes are forwarded as-is
 * so the user can finish typing).
 */
import { useMemo, useState, type JSX } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronDown, Info, Activity, Shield, Zap, Copy, GitBranch,
} from 'lucide-react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

// ============================================
// Public Contract
// ============================================

export interface AggregationOverridesValue {
    batchSize: number          // 100..50000 (validator displays a warning outside this range)
    projectionMode: 'in_source' | 'dedicated'
    maxRetries: number         // 0..10
    timeoutMinutes: number     // 1..1440 (UI uses minutes; callers convert to seconds at the API boundary)
}

export interface AggregationOverridesFormProps {
    value: AggregationOverridesValue
    onChange: (next: AggregationOverridesValue) => void
    disabled?: boolean         // true while the parent's submit is in flight
    /** Optional: hide the projectionMode selector when the parent doesn't allow changing it */
    hideProjectionMode?: boolean
}

// ============================================
// Bounds & Clamping
// ============================================

const BATCH_MIN = 100
const BATCH_MAX = 50000
const RETRIES_MIN = 0
const RETRIES_MAX = 10
const TIMEOUT_MIN = 1
const TIMEOUT_MAX = 1440

const clampBatch = (n: number) => Math.max(BATCH_MIN, Math.min(BATCH_MAX, n))
const clampRetries = (n: number) => Math.max(RETRIES_MIN, Math.min(RETRIES_MAX, n))
const clampTimeout = (n: number) => Math.max(TIMEOUT_MIN, Math.min(TIMEOUT_MAX, n))

// ============================================
// Inline Sub-components
// ============================================

function Tip({ children, label }: { children: React.ReactNode; label: string }) {
    return (
        <TooltipPrimitive.Provider delayDuration={300}>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                        side="top"
                        sideOffset={6}
                        className="z-50 max-w-xs px-3 py-2 rounded-lg bg-ink text-canvas text-[11px] font-medium shadow-lg animate-in fade-in zoom-in-95 duration-150 leading-relaxed"
                    >
                        {label}
                        <TooltipPrimitive.Arrow className="fill-ink" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    )
}

function ImpactMeter({ label, level, max = 5 }: { label: string; level: number; max?: number }) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-[9px] text-ink-muted uppercase tracking-wider w-16 shrink-0">{label}</span>
            <div className="flex gap-0.5">
                {Array.from({ length: max }, (_, i) => (
                    <div key={i} className={cn(
                        'w-3 h-1.5 rounded-full transition-colors duration-300',
                        i < level
                            ? level <= 2 ? 'bg-emerald-500' : level <= 3 ? 'bg-amber-500' : 'bg-red-400'
                            : 'bg-black/[0.06] dark:bg-white/[0.08]'
                    )} />
                ))}
            </div>
        </div>
    )
}

// ============================================
// Config Presets
// ============================================

interface ConfigPreset {
    id: 'conservative' | 'balanced' | 'performance'
    label: string
    description: string
    icon: typeof Shield
    batchSize: number
    maxRetries: number
    timeoutMinutes: number
}

const CONFIG_PRESETS: ConfigPreset[] = [
    {
        id: 'conservative',
        label: 'Conservative',
        description: 'Safest option — low memory, high resilience',
        icon: Shield,
        batchSize: 500,
        maxRetries: 5,
        timeoutMinutes: 180,
    },
    {
        id: 'balanced',
        label: 'Balanced',
        description: 'Recommended for most workloads',
        icon: Activity,
        batchSize: 1000,
        maxRetries: 3,
        timeoutMinutes: 120,
    },
    {
        id: 'performance',
        label: 'Performance',
        description: 'Maximum throughput, less fault-tolerant',
        icon: Zap,
        batchSize: 5000,
        maxRetries: 1,
        timeoutMinutes: 60,
    },
]

// ============================================
// Component
// ============================================

export function AggregationOverridesForm({
    value,
    onChange,
    disabled = false,
    hideProjectionMode = false,
}: AggregationOverridesFormProps): JSX.Element {
    const [showAdvanced, setShowAdvanced] = useState(false)

    const activePreset = useMemo(() => {
        return CONFIG_PRESETS.find(p =>
            p.batchSize === value.batchSize &&
            p.maxRetries === value.maxRetries &&
            p.timeoutMinutes === value.timeoutMinutes
        )?.id ?? null
    }, [value.batchSize, value.maxRetries, value.timeoutMinutes])

    const currentTraits = useMemo(() => {
        const bs = value.batchSize
        const mr = value.maxRetries
        const tm = value.timeoutMinutes
        return {
            memory: bs <= 500 ? 1 : bs <= 1000 ? 2 : bs <= 2000 ? 3 : bs <= 5000 ? 4 : 5,
            speed: Math.min(5, Math.max(1, Math.round(
                (bs <= 500 ? 1 : bs <= 1000 ? 2 : bs <= 2000 ? 3 : bs <= 5000 ? 4 : 5) * 0.6 +
                (tm <= 60 ? 5 : tm <= 120 ? 3 : tm <= 180 ? 2 : 1) * 0.4
            ))),
            reliability: mr >= 5 ? 5 : mr >= 3 ? 3 : mr >= 1 ? 2 : 1,
        }
    }, [value.batchSize, value.maxRetries, value.timeoutMinutes])

    const update = (patch: Partial<AggregationOverridesValue>) => {
        onChange({ ...value, ...patch })
    }

    const applyPreset = (preset: ConfigPreset) => {
        update({
            batchSize: preset.batchSize,
            maxRetries: preset.maxRetries,
            timeoutMinutes: preset.timeoutMinutes,
        })
    }

    return (
        <div className={cn('space-y-4', disabled && 'opacity-60 pointer-events-none')}>
            {/* ─── Projection Mode Selector (optional) ──────────────────────── */}
            {!hideProjectionMode && (
                <div>
                    <label className="block text-[11px] font-medium text-ink-secondary mb-2 uppercase tracking-wider">
                        Projection Mode
                    </label>
                    <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Projection mode">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={value.projectionMode === 'in_source'}
                            disabled={disabled}
                            onClick={() => update({ projectionMode: 'in_source' })}
                            className={cn(
                                'rounded-xl border p-3 text-left transition-all',
                                value.projectionMode === 'in_source'
                                    ? 'border-indigo-500/40 bg-indigo-500/10'
                                    : 'border-glass-border hover:border-indigo-500/20',
                                disabled && 'cursor-not-allowed'
                            )}
                        >
                            <div className="flex items-center gap-2 mb-1.5">
                                <Copy className="w-3.5 h-3.5 text-indigo-500" />
                                <span className={cn(
                                    'text-xs font-semibold',
                                    value.projectionMode === 'in_source' ? 'text-indigo-400' : 'text-ink'
                                )}>
                                    In-Source
                                </span>
                            </div>
                            <p className="text-[11px] text-ink-muted leading-relaxed">
                                Write aggregated edges directly into the physical graph. Zero query latency.
                            </p>
                        </button>

                        <button
                            type="button"
                            role="radio"
                            aria-checked={value.projectionMode === 'dedicated'}
                            disabled={disabled}
                            onClick={() => update({ projectionMode: 'dedicated' })}
                            className={cn(
                                'rounded-xl border p-3 text-left transition-all',
                                value.projectionMode === 'dedicated'
                                    ? 'border-indigo-500/40 bg-indigo-500/10'
                                    : 'border-glass-border hover:border-indigo-500/20',
                                disabled && 'cursor-not-allowed'
                            )}
                        >
                            <div className="flex items-center gap-2 mb-1.5">
                                <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                                <span className={cn(
                                    'text-xs font-semibold',
                                    value.projectionMode === 'dedicated' ? 'text-indigo-400' : 'text-ink'
                                )}>
                                    Dedicated Graph
                                </span>
                            </div>
                            <p className="text-[11px] text-ink-muted leading-relaxed">
                                Project aggregated relationships to an isolated cache graph. Source stays untouched.
                            </p>
                        </button>
                    </div>
                </div>
            )}

            {/* ─── Fine-Tune Performance ────────────────────────────────────── */}
            <div className="rounded-xl border border-glass-border overflow-hidden">
                {/* Toggle */}
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className={cn(
                        'flex items-center gap-2 w-full px-4 py-3 text-left transition-colors',
                        !disabled && 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                        disabled && 'cursor-not-allowed'
                    )}
                >
                    <ChevronDown className={cn(
                        'w-4 h-4 text-ink-muted transition-transform duration-200',
                        showAdvanced && 'rotate-180'
                    )} />
                    <span className="text-xs font-semibold text-ink-secondary">Fine-Tune Performance</span>
                    {activePreset && (
                        <span className="text-[10px] text-indigo-400 font-medium ml-1.5">
                            {CONFIG_PRESETS.find(p => p.id === activePreset)?.label}
                        </span>
                    )}
                    <span className="text-[10px] text-ink-muted ml-auto">Optional</span>
                </button>

                {/* Expandable Content */}
                <AnimatePresence>
                    {showAdvanced && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                        >
                            <div className="px-4 pb-4 pt-3 border-t border-glass-border/50 space-y-4">
                                {/* Preset Selector */}
                                <div className="grid grid-cols-3 gap-3">
                                    {CONFIG_PRESETS.map(preset => {
                                        const Icon = preset.icon
                                        const isActive = activePreset === preset.id
                                        return (
                                            <motion.button
                                                key={preset.id}
                                                type="button"
                                                disabled={disabled}
                                                whileHover={disabled ? undefined : { scale: 1.02 }}
                                                whileTap={disabled ? undefined : { scale: 0.98 }}
                                                onClick={() => applyPreset(preset)}
                                                className={cn(
                                                    'rounded-xl border p-3 text-left transition-all',
                                                    isActive
                                                        ? 'border-indigo-500/40 bg-indigo-500/5 ring-2 ring-indigo-500/20 shadow-lg shadow-indigo-500/5'
                                                        : 'border-glass-border hover:border-indigo-500/20',
                                                    disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                                                )}
                                            >
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Icon className={cn(
                                                        'w-4 h-4',
                                                        isActive ? 'text-indigo-400' : 'text-ink-muted'
                                                    )} />
                                                    <span className={cn(
                                                        'text-xs font-semibold',
                                                        isActive ? 'text-indigo-400' : 'text-ink'
                                                    )}>
                                                        {preset.label}
                                                    </span>
                                                </div>
                                                <p className="text-[10px] text-ink-muted leading-relaxed">
                                                    {preset.description}
                                                </p>
                                            </motion.button>
                                        )
                                    })}
                                </div>

                                {/* Parameter Grid */}
                                <div className="grid grid-cols-3 gap-4">
                                    {/* Batch Size */}
                                    <div>
                                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                                            Batch Size
                                            <Tip label="Number of edges processed per database transaction. Higher values mean fewer round trips to the database but require more memory per batch. Start low for graphs with complex edge properties.">
                                                <span><Info className="w-3 h-3 text-ink-muted/60 cursor-help" /></span>
                                            </Tip>
                                        </label>
                                        <input
                                            type="number"
                                            min={BATCH_MIN}
                                            max={BATCH_MAX}
                                            disabled={disabled}
                                            value={value.batchSize}
                                            onChange={e => {
                                                const parsed = parseInt(e.target.value)
                                                if (Number.isFinite(parsed)) {
                                                    update({ batchSize: parsed })
                                                }
                                            }}
                                            onBlur={e => {
                                                const v = parseInt(e.target.value)
                                                update({ batchSize: clampBatch(Number.isFinite(v) ? v : 1000) })
                                            }}
                                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink outline-none transition-all focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">Edges per batch (100-50,000)</p>
                                        <div className="mt-1.5">
                                            <ImpactMeter label="Memory" level={currentTraits.memory} />
                                        </div>
                                    </div>

                                    {/* Max Retries */}
                                    <div>
                                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                                            Max Retries
                                            <Tip label="How many times a failed batch is retried before marking the job as failed. Higher values increase resilience to transient network errors and database locks.">
                                                <span><Info className="w-3 h-3 text-ink-muted/60 cursor-help" /></span>
                                            </Tip>
                                        </label>
                                        <input
                                            type="number"
                                            min={RETRIES_MIN}
                                            max={RETRIES_MAX}
                                            disabled={disabled}
                                            value={value.maxRetries}
                                            onChange={e => {
                                                const parsed = parseInt(e.target.value)
                                                if (Number.isFinite(parsed)) {
                                                    update({ maxRetries: parsed })
                                                }
                                            }}
                                            onBlur={e => {
                                                const v = parseInt(e.target.value)
                                                update({ maxRetries: clampRetries(Number.isFinite(v) ? v : 0) })
                                            }}
                                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink outline-none transition-all focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">Retry attempts on failure (0-10)</p>
                                        <div className="mt-1.5">
                                            <ImpactMeter label="Reliab." level={currentTraits.reliability} />
                                        </div>
                                    </div>

                                    {/* Timeout */}
                                    <div>
                                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                                            Timeout (minutes)
                                            <Tip label="Maximum wall-clock duration the aggregation job can run. Prevents runaway jobs from consuming resources indefinitely.">
                                                <span><Info className="w-3 h-3 text-ink-muted/60 cursor-help" /></span>
                                            </Tip>
                                        </label>
                                        <input
                                            type="number"
                                            min={TIMEOUT_MIN}
                                            max={TIMEOUT_MAX}
                                            disabled={disabled}
                                            value={value.timeoutMinutes}
                                            onChange={e => {
                                                const parsed = parseInt(e.target.value)
                                                if (Number.isFinite(parsed)) {
                                                    update({ timeoutMinutes: parsed })
                                                }
                                            }}
                                            onBlur={e => {
                                                const v = parseInt(e.target.value)
                                                update({ timeoutMinutes: clampTimeout(Number.isFinite(v) ? v : 120) })
                                            }}
                                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink outline-none transition-all focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">Max job duration (1-1440 min)</p>
                                        <div className="mt-1.5">
                                            <ImpactMeter label="Speed" level={currentTraits.speed} />
                                        </div>
                                    </div>
                                </div>

                                {/* Estimated Impact Guidance */}
                                <div className="pt-3 border-t border-glass-border/50">
                                    <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2">Guidance for Your Graph Size</p>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="text-[11px] text-ink-muted">
                                            <span className="font-semibold text-ink-secondary">Small (&lt;10K edges)</span>
                                            <p className="mt-0.5 leading-relaxed">Batch 500 &middot; 2-5 min</p>
                                        </div>
                                        <div className="text-[11px] text-ink-muted">
                                            <span className="font-semibold text-ink-secondary">Medium (10K-100K)</span>
                                            <p className="mt-0.5 leading-relaxed">Batch 1000 &middot; 10-30 min</p>
                                        </div>
                                        <div className="text-[11px] text-ink-muted">
                                            <span className="font-semibold text-ink-secondary">Large (100K+)</span>
                                            <p className="mt-0.5 leading-relaxed">Batch 5000 &middot; 30-120 min</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    )
}

export default AggregationOverridesForm
