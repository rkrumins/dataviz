/**
 * AggregationOverridesForm - Shared, controlled form for aggregation overrides.
 *
 * Extracted from `AssetOnboardingWizard/steps/AggregationStep.tsx` so it can be
 * reused in the "Re-trigger with overrides" dialog. The component is purely
 * controlled: the parent owns `value`, and the component emits `onChange(next)`
 * with a fully-formed value on every edit. Only UI-only state (`showAdvanced`)
 * lives inside the component.
 *
 * Bounds: maxRetries 0..10, timeoutMinutes 1..1440, plus the pipeline tuning
 * caps/floors in TUNING_FIELDS. Out-of-range values are clamped on blur (live
 * keystrokes are forwarded as-is so the user can finish typing).
 *
 * Note: `batchSize` remains in the value shape for API backward compatibility
 * but is no longer rendered — the new pipeline self-tunes its batches (AIMD).
 */
import { useMemo, useState, type JSX } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronDown, Info, Activity, Shield, Zap, Copy, GitBranch,
} from 'lucide-react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'
import type { AggregationTuning } from '@/services/aggregationService'

// ============================================
// Public Contract
// ============================================

export interface AggregationOverridesValue {
    batchSize: number          // kept for API backward-compat; inert on the self-tuning pipeline (not rendered)
    projectionMode: 'in_source' | 'dedicated'
    maxRetries: number         // 0..10
    timeoutMinutes: number     // 1..1440 (UI uses minutes; callers convert to seconds at the API boundary)
    tuning?: AggregationTuning // optional caps/floors for the self-tuning pipeline
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

const RETRIES_MIN = 0
const RETRIES_MAX = 10
const TIMEOUT_MIN = 1
const TIMEOUT_MAX = 1440

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
// Advanced Tuning (shared with the admin "Defaults" dialog)
// ============================================

interface TuningFieldSpec {
    key: 'scanRangeWidth' | 'writePacingRatio' | 'maxPendingPairs' | 'extractConcurrency' | 'maxMaterializedEdges'
    label: string
    tip: string
    help: string
    min: number
    max: number
    placeholder: number
    step?: number
    float?: boolean
}

const TUNING_FIELDS: TuningFieldSpec[] = [
    {
        key: 'scanRangeWidth',
        label: 'Scan range width',
        tip: 'Width of each edge-ID range the extract phase scans per query. The pipeline shrinks this automatically under pressure — this value is the ceiling.',
        help: 'Edges per scan range (10,000-5,000,000)',
        min: 10_000, max: 5_000_000, placeholder: 200_000,
    },
    {
        key: 'writePacingRatio',
        label: 'Write pacing ratio',
        tip: 'Idle time inserted between write chunks, as a ratio of the previous chunk’s duration. Higher values leave more headroom for live queries but make the job slower; 0 disables pacing entirely.',
        help: 'Pause between writes (0-10)',
        min: 0, max: 10, placeholder: 1.0, step: 0.1, float: true,
    },
    {
        key: 'maxPendingPairs',
        label: 'Memory cap — max pending pairs',
        tip: 'Maximum aggregated pairs held in memory before the pipeline flushes early. Lower values reduce worker RSS at the cost of more flush cycles.',
        help: 'Pairs held in memory (50,000-50,000,000)',
        min: 50_000, max: 50_000_000, placeholder: 50_000_000,
    },
    {
        key: 'extractConcurrency',
        label: 'Extract concurrency',
        tip: 'Number of parallel extract scans. Higher values speed up the extract phase but put more read load on the provider.',
        help: 'Parallel scans (1-4)',
        min: 1, max: 4, placeholder: 1,
    },
    {
        key: 'maxMaterializedEdges',
        label: 'Materialization budget',
        tip: 'Hard ceiling on stored AGGREGATED edges (~0.5KB of graph memory each). A backstop, not a sizing guard — forced full detail fails loudly instead of exceeding it. Size it against a SINGLE graph store node: a graph never spans cluster shards, so sharding adds no headroom for one large graph. Auto storage decides cube-vs-diagonal against its own ceiling, so raising this does not change that choice.',
        help: 'Max stored rollup edges (10,000-50,000,000)',
        min: 10_000, max: 50_000_000, placeholder: 16_000_000,
    },
]

export interface TuningFieldsProps {
    value: AggregationTuning
    onChange: (next: AggregationTuning) => void
    disabled?: boolean
}

/**
 * TuningFields — the raw Advanced-tuning inputs, without the collapsible
 * shell, so the workspace dashboard's "Defaults" dialog can reuse them.
 * Empty inputs mean "no override" (the key is omitted from `tuning`).
 */
export function TuningFields({ value, onChange, disabled = false }: TuningFieldsProps): JSX.Element {
    const setField = (spec: TuningFieldSpec, raw: string, clamp: boolean) => {
        const next: AggregationTuning = { ...value }
        const parsed = spec.float ? parseFloat(raw) : parseInt(raw)
        if (raw === '' || !Number.isFinite(parsed)) {
            // Cleared (or garbage on blur) → drop the override, fall back to default.
            if (raw === '' || clamp) {
                delete next[spec.key]
                onChange(next)
            }
            return
        }
        next[spec.key] = clamp ? Math.max(spec.min, Math.min(spec.max, parsed)) : parsed
        onChange(next)
    }

    const materialize = value.materializeLeafPairs ?? false
    // undefined = Auto (cube within budget, diagonal above it);
    // true = force full detail (fails loudly if over budget).
    const fullDetail = value.materializeFinePairs === true

    const setStrategy = (force: boolean) => {
        const next: AggregationTuning = { ...value }
        if (force) next.materializeFinePairs = true
        else delete next.materializeFinePairs
        onChange(next)
    }

    return (
        <div className="space-y-4">
            {/* Storage strategy: pre-create everything vs auto */}
            <div>
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                    Rollup storage
                    <Tip label="Auto stores every ancestor combination when the estimate fits what the graph instance can hold, and falls back to the canonical depth-diagonal above it (finer granularities are derived on demand at read time — nothing is lost, it is just not pre-created). Full detail always pre-creates every combination and FAILS the job instead of exceeding the materialization budget; on multi-million-edge graphs that combination is what exhausts the instance, so Auto is the safe choice at scale.">
                        <span><Info className="w-3 h-3 text-ink-muted/60 cursor-help" /></span>
                    </Tip>
                </label>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Rollup storage">
                    <button
                        type="button"
                        role="radio"
                        aria-checked={!fullDetail}
                        disabled={disabled}
                        onClick={() => setStrategy(false)}
                        className={cn(
                            'px-3 py-2 rounded-lg border text-left transition-colors duration-150',
                            !fullDetail ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-glass-border hover:border-indigo-500/20',
                            disabled && 'cursor-not-allowed opacity-60',
                        )}
                    >
                        <span className="block text-[11px] font-medium text-ink-secondary">Auto (recommended)</span>
                        <span className="block text-[10px] text-ink-muted mt-0.5">Full detail within budget; diagonal + on-demand above it.</span>
                    </button>
                    <button
                        type="button"
                        role="radio"
                        aria-checked={fullDetail}
                        disabled={disabled}
                        onClick={() => setStrategy(true)}
                        className={cn(
                            'px-3 py-2 rounded-lg border text-left transition-colors duration-150',
                            fullDetail ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-glass-border hover:border-indigo-500/20',
                            disabled && 'cursor-not-allowed opacity-60',
                        )}
                    >
                        <span className="block text-[11px] font-medium text-ink-secondary">Always full detail</span>
                        <span className="block text-[10px] text-ink-muted mt-0.5">Pre-create every combination; fails instead of exceeding the budget.</span>
                    </button>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
                {TUNING_FIELDS.map(spec => (
                    <div key={spec.key}>
                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                            {spec.label}
                            <Tip label={spec.tip}>
                                <span><Info className="w-3 h-3 text-ink-muted/60 cursor-help" /></span>
                            </Tip>
                        </label>
                        <input
                            type="number"
                            min={spec.min}
                            max={spec.max}
                            step={spec.step}
                            disabled={disabled}
                            placeholder={String(spec.placeholder)}
                            value={value[spec.key] ?? ''}
                            onChange={e => setField(spec, e.target.value, false)}
                            onBlur={e => setField(spec, e.target.value, true)}
                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink placeholder:text-ink-muted/50 outline-none transition-colors duration-150 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                        <p className="text-[10px] text-ink-muted mt-1">{spec.help}</p>
                    </div>
                ))}
            </div>

            {/* Materialize leaf-to-leaf pairs toggle */}
            <button
                type="button"
                role="switch"
                aria-checked={materialize}
                disabled={disabled}
                onClick={() => onChange({ ...value, materializeLeafPairs: !materialize })}
                className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors duration-150',
                    materialize
                        ? 'border-indigo-500/30 bg-indigo-500/5'
                        : 'border-glass-border hover:border-indigo-500/20',
                    disabled && 'cursor-not-allowed'
                )}
            >
                <div className={cn(
                    'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
                    materialize ? 'bg-indigo-500/85' : 'bg-ink-muted/25 dark:bg-white/15',
                )}>
                    <div className={cn(
                        'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
                        materialize ? 'left-[15px]' : 'left-[2px]',
                    )} />
                </div>
                <div className="flex-1 min-w-0">
                    <span className={cn(
                        'block text-[11px] font-medium',
                        materialize ? 'text-indigo-400' : 'text-ink-secondary'
                    )}>
                        Materialize leaf-to-leaf pairs
                    </span>
                    <span className="block text-[10px] text-ink-muted mt-0.5">
                        Write direct leaf-to-leaf aggregated edges in addition to rollups. Disable to cut writes and memory on very dense graphs.
                    </span>
                </div>
            </button>
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
    maxRetries: number
    timeoutMinutes: number
    tuning: AggregationTuning
}

/**
 * Every preset carries the same CAPACITY FLOOR — budgets, rollup storage
 * and timeout — so any profile completes a large graph (1M nodes / 2M
 * edges and beyond) out of the box. Capacity is not a preference; it is
 * what stops a job failing on the write budget. What the presets actually
 * trade off is how hard they lean on the provider: pacing, extract
 * concurrency, scan width and retries.
 *
 * `materializeFinePairs` is deliberately ABSENT from every preset. It is
 * typed `boolean | undefined` and "Auto" is only expressible by OMITTING
 * the key, so setting it here would force full-detail — the mode that
 * OOMs a multi-million-edge graph.
 */
const CAPACITY_FLOOR = {
    // Worker RSS bound — unaffected by the graph store's topology.
    maxPendingPairs: 50_000_000,
    // Graph-store bound, so sized against ONE SHARD: a graph key never
    // spans shards, and the reference cluster runs maxmemory 40gb per
    // shard with ~18GB free. 16M x ~0.5KB ~= 8GB.
    maxMaterializedEdges: 16_000_000,
} as const

/**
 * Stall-timeout default, shared by every trigger path so a job started
 * from the banner or a workspace card gets the same no-progress window as
 * one started from this form. Exported in seconds too, since the API takes
 * ``timeoutSecs``.
 */
export const PRESET_TIMEOUT_MINUTES = 180
export const DEFAULT_TIMEOUT_SECS = PRESET_TIMEOUT_MINUTES * 60

export const CONFIG_PRESETS: ConfigPreset[] = [
    {
        id: 'conservative',
        label: 'Conservative',
        description: 'Safest option — lowest provider load, gentlest write pacing',
        icon: Shield,
        maxRetries: 5,
        timeoutMinutes: PRESET_TIMEOUT_MINUTES,
        tuning: { ...CAPACITY_FLOOR, scanRangeWidth: 100_000, writePacingRatio: 2.0, extractConcurrency: 1 },
    },
    {
        id: 'balanced',
        label: 'Balanced',
        description: 'Recommended — handles large graphs at a gentle write duty cycle',
        icon: Activity,
        maxRetries: 3,
        timeoutMinutes: PRESET_TIMEOUT_MINUTES,
        tuning: { ...CAPACITY_FLOOR, scanRangeWidth: 200_000, writePacingRatio: 1.0, extractConcurrency: 1 },
    },
    {
        id: 'performance',
        label: 'Performance',
        description: 'Maximum throughput, heavier provider load',
        icon: Zap,
        maxRetries: 1,
        timeoutMinutes: PRESET_TIMEOUT_MINUTES,
        tuning: { ...CAPACITY_FLOOR, scanRangeWidth: 500_000, writePacingRatio: 0.25, extractConcurrency: 3 },
    },
]

const TUNING_KEYS: (keyof AggregationTuning)[] = [
    'scanRangeWidth', 'maxPendingPairs', 'applyChunk', 'deleteChunk',
    'writePacingRatio', 'extractConcurrency', 'materializeLeafPairs',
    'maxMaterializedEdges', 'materializeFinePairs',
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
        const tuning = value.tuning ?? {}
        return CONFIG_PRESETS.find(p =>
            p.maxRetries === value.maxRetries &&
            p.timeoutMinutes === value.timeoutMinutes &&
            TUNING_KEYS.every(k => tuning[k] === p.tuning[k])
        )?.id ?? null
    }, [value.maxRetries, value.timeoutMinutes, value.tuning])

    const currentTraits = useMemo(() => {
        const mr = value.maxRetries
        // Throughput is set by the write duty cycle and scan parallelism —
        // NOT by the timeout, which only bounds how long a job may sit
        // making no progress. Pacing is a sleep multiplier, so lower is
        // faster: 0 → no pause, 1.0 → ~50% duty cycle.
        const pacing = value.tuning?.writePacingRatio ?? 1.0
        const concurrency = value.tuning?.extractConcurrency ?? 1
        const pacingScore = pacing <= 0 ? 5 : pacing <= 0.25 ? 4 : pacing <= 0.5 ? 3 : pacing <= 1.0 ? 2 : 1
        const concurrencyScore = concurrency >= 4 ? 5 : concurrency >= 3 ? 4 : concurrency >= 2 ? 3 : 2
        return {
            speed: Math.max(1, Math.min(5, Math.round((pacingScore * 2 + concurrencyScore) / 3))),
            reliability: mr >= 5 ? 5 : mr >= 3 ? 3 : mr >= 1 ? 2 : 1,
        }
    }, [value.maxRetries, value.tuning])

    const update = (patch: Partial<AggregationOverridesValue>) => {
        onChange({ ...value, ...patch })
    }

    const applyPreset = (preset: ConfigPreset) => {
        update({
            maxRetries: preset.maxRetries,
            timeoutMinutes: preset.timeoutMinutes,
            tuning: { ...preset.tuning },
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
                                'rounded-xl border p-3 text-left transition-colors duration-150',
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
                                'rounded-xl border p-3 text-left transition-colors duration-150',
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
                                                    'rounded-xl border p-3 text-left transition-colors duration-150',
                                                    isActive
                                                        ? 'border-indigo-500/40 bg-indigo-500/5 ring-2 ring-indigo-500/20 shadow-md'
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
                                <div className="grid grid-cols-2 gap-4">
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
                                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink outline-none transition-colors duration-150 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">Retry attempts on failure (0-10)</p>
                                        <div className="mt-1.5">
                                            <ImpactMeter label="Reliab." level={currentTraits.reliability} />
                                        </div>
                                    </div>

                                    {/* Timeout */}
                                    <div>
                                        <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary mb-1.5">
                                            Stall timeout (minutes)
                                            <Tip label="How long the job may make NO forward progress before the watchdog kills it. This is not a cap on total runtime — a job that keeps progressing runs until it finishes (up to a 24h safety net), so a long value here only decides how long a genuinely wedged job holds the graph's write lease.">
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
                                                update({ timeoutMinutes: clampTimeout(Number.isFinite(v) ? v : PRESET_TIMEOUT_MINUTES) })
                                            }}
                                            className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink outline-none transition-colors duration-150 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 border-glass-border disabled:opacity-60 disabled:cursor-not-allowed"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">No-progress window (1-1440 min)</p>
                                        <div className="mt-1.5">
                                            <ImpactMeter label="Speed" level={currentTraits.speed} />
                                        </div>
                                    </div>
                                </div>

                                {/* Advanced tuning — pipeline caps/floors */}
                                <div className="pt-3 border-t border-glass-border/50 space-y-3">
                                    <div>
                                        <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Advanced Tuning</p>
                                        <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                                            The pipeline is self-tuning (AIMD) — it adapts batch and chunk sizes to
                                            provider latency automatically. These settings are caps and floors, not
                                            fixed values. Leave blank to use the defaults shown.
                                        </p>
                                    </div>
                                    <TuningFields
                                        value={value.tuning ?? {}}
                                        onChange={tuning => update({ tuning })}
                                        disabled={disabled}
                                    />
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
