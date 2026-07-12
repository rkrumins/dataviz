/**
 * CreationPhase — the wizard's terminal step: creating the view, then handing it over.
 *
 * These are STEP BODIES + FOOTERS, not modals. They render inside `WizardShell`
 * exactly like every other step, so the header, the stepper and the footer stay
 * put and creating a view reads as the last step of the wizard rather than a
 * detached card that appears and then vanishes. (It previously rendered its own
 * Backdrop + card, which is why it looked like a mystery dialog.)
 *
 * Stages are one row per awaited call, because that is genuinely all the
 * frontend can observe. We do NOT invent sub-steps we can't see.
 *
 * On success the view is already saved: the footer offers to open it now and,
 * if the user does nothing, opens it for them after a short countdown (paused
 * while they're reading the summary, cancelled by any click).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, ArrowRight, Check, Compass, Database, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/lib/viewUtils'

// ─── Types ──────────────────────────────────────────────────────────────────

export type CreationStageId = 'provision' | 'create' | 'layout'
export type CreationStageState = 'pending' | 'active' | 'done' | 'failed'

export interface CreationStage {
    id: CreationStageId
    label: string
    detail?: string
    state: CreationStageState
}

export interface CreationSummaryStat {
    label: string
    value: string | number
}

/** Seconds the success step waits before opening the view on the user's behalf. */
export const AUTO_OPEN_SECONDS = 5

// ─── Auto-open countdown ────────────────────────────────────────────────────

/**
 * Ticks down while `enabled`, fires once, and never fires again. Hoisted out of
 * the success body because the countdown drives BOTH the body and the wizard
 * footer (the "Open view now" action bar).
 *
 * Deliberately NOT hover-pausable. The pause read as considerate and was in fact
 * useless: after clicking "Create" the pointer is already sitting on the modal, so
 * the countdown started paused and stayed paused — the auto-open we promised
 * simply never happened, and the footer just said "paused while you're reading"
 * forever. A countdown that runs, plus one obvious way to stop it ("Stay here"),
 * is both easier to reason about and the version that actually works.
 */
export function useAutoOpenCountdown({
    enabled,
    seconds = AUTO_OPEN_SECONDS,
    onFire,
}: {
    enabled: boolean
    seconds?: number
    onFire: () => void
}): {
    remaining: number
    cancel: () => void
} {
    const [remaining, setRemaining] = useState(seconds)
    const firedRef = useRef(false)

    // Keep the callback fresh without restarting the timer on every render.
    const onFireRef = useRef(onFire)
    useEffect(() => { onFireRef.current = onFire })

    // No reset branch on purpose: the wizard unmounts when it closes, so a fresh
    // create always starts from a fresh hook. `enabled` only ever goes false→true
    // (steps → success), never back.
    useEffect(() => {
        if (!enabled || firedRef.current || remaining < 0) return
        if (remaining === 0) {
            firedRef.current = true
            onFireRef.current()
            return
        }
        const t = setTimeout(() => setRemaining(r => r - 1), 1000)
        return () => clearTimeout(t)
    }, [enabled, remaining])

    /** Any deliberate click wins over the countdown. */
    const cancel = useCallback(() => {
        firedRef.current = true
        setRemaining(-1)
    }, [])

    return { remaining, cancel }
}

// ─── Creating ───────────────────────────────────────────────────────────────

function StageRow({ stage }: { stage: CreationStage }) {
    const icon = {
        done: <Check className="w-4 h-4 text-white" />,
        active: <Loader2 className="w-4 h-4 text-white animate-spin" />,
        failed: <AlertCircle className="w-4 h-4 text-white" />,
        pending: <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />,
    }[stage.state]

    const dotClass = {
        done: 'bg-emerald-500',
        active: 'bg-blue-500 shadow-md shadow-blue-500/25',
        failed: 'bg-red-500',
        pending: 'bg-slate-200 dark:bg-slate-700',
    }[stage.state]

    return (
        <div
            className={cn(
                'flex items-start gap-4 rounded-xl border px-4 py-3.5 transition-colors',
                stage.state === 'active'
                    ? 'border-blue-500/30 bg-blue-500/5'
                    : stage.state === 'failed'
                        ? 'border-red-500/30 bg-red-500/5'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/40',
            )}
        >
            <div className={cn('w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors', dotClass)}>
                {icon}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
                <p className={cn(
                    'text-sm font-semibold transition-colors',
                    stage.state === 'pending'
                        ? 'text-slate-400'
                        : stage.state === 'failed'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-slate-800 dark:text-slate-200',
                )}>
                    {stage.label}
                </p>
                {stage.detail && (
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{stage.detail}</p>
                )}
            </div>
            {stage.state === 'done' && (
                <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0 pt-1">Done</span>
            )}
        </div>
    )
}

export function CreationProgressBody({
    stages,
    viewName,
    error,
}: {
    stages: CreationStage[]
    viewName: string
    error: string | null
}) {
    return (
        <div className="min-h-[440px] flex flex-col items-center justify-center">
            <div className="w-full max-w-xl">
                <div className="text-center mb-8">
                    <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
                        {error ? 'We couldn’t finish' : 'Creating your view'}
                    </h3>
                    <p className="mt-1.5 text-sm text-slate-500 truncate" title={viewName}>
                        {error
                            ? 'Your work is safe — pick up exactly where it stopped.'
                            : <>Hang tight — <span className="font-semibold text-slate-700 dark:text-slate-300">{viewName}</span> is on its way.</>}
                    </p>
                </div>

                <div className="space-y-2.5" aria-live="polite">
                    {stages.map(stage => <StageRow key={stage.id} stage={stage} />)}
                </div>

                {error && (
                    <div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                        <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">{error}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                            Nothing was lost. Retrying resumes from the step that failed — it will never
                            create a second view.
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}

/** Footer while the create is in flight — deliberately actionless. */
export function CreationBusyFooter() {
    return (
        <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            Saving your view — this only takes a moment
        </div>
    )
}

export function CreationErrorFooter({
    onBack,
    onRetry,
    suggestedName,
    onUseSuggestedName,
}: {
    onBack: () => void
    onRetry: () => void
    /** Set when the graph name was taken while the wizard was open. */
    suggestedName?: string | null
    onUseSuggestedName?: () => void
}) {
    // A taken graph name cannot be retried into existence — the server will refuse
    // the same name every time (writing into an existing key would destroy it). So
    // the primary action becomes "take the free one", not "try again".
    const nameTaken = !!suggestedName && !!onUseSuggestedName

    return (
        <div className="flex items-center justify-between w-full gap-4">
            <button
                type="button"
                onClick={onBack}
                className="px-5 py-2.5 rounded-xl font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors duration-150 shrink-0"
            >
                Back to review
            </button>

            {nameTaken ? (
                <button
                    type="button"
                    onClick={onUseSuggestedName}
                    className="flex items-center gap-2 min-w-0 px-6 py-2.5 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md transition-colors duration-150"
                >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    <span className="truncate">Use <span className="font-mono">{suggestedName}</span> instead</span>
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md transition-colors duration-150 shrink-0"
                >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                </button>
            )}
        </div>
    )
}

// ─── Success ────────────────────────────────────────────────────────────────

const CONFETTI_KEYFRAMES = `
@keyframes vw-confetti-fall {
  0%   { transform: translate3d(0, -12px, 0) rotate(0deg); opacity: 1; }
  100% { transform: translate3d(var(--vw-dx), 240px, 0) rotate(var(--vw-rot)); opacity: 0; }
}
.vw-confetti-piece { animation: vw-confetti-fall 1.25s ease-out forwards; }
@media (prefers-reduced-motion: reduce) { .vw-confetti-piece { display: none; } }
`

/** Deterministic confetti — transform/opacity only, no layout thrash. */
const CONFETTI = [
    { dx: '-62px', rot: '-150deg', delay: '0ms', color: '#3b82f6', left: '22%' },
    { dx: '38px', rot: '120deg', delay: '40ms', color: '#8b5cf6', left: '31%' },
    { dx: '-20px', rot: '210deg', delay: '90ms', color: '#22c55e', left: '40%' },
    { dx: '56px', rot: '-95deg', delay: '20ms', color: '#f59e0b', left: '48%' },
    { dx: '-46px', rot: '165deg', delay: '120ms', color: '#ec4899', left: '56%' },
    { dx: '26px', rot: '-185deg', delay: '70ms', color: '#06b6d4', left: '64%' },
    { dx: '-10px', rot: '95deg', delay: '150ms', color: '#6366f1', left: '73%' },
    { dx: '48px', rot: '140deg', delay: '110ms', color: '#22c55e', left: '78%' },
]

function ConfettiBurst() {
    return (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-6 h-56 overflow-hidden">
            <style>{CONFETTI_KEYFRAMES}</style>
            {CONFETTI.map((p, i) => (
                <span
                    key={i}
                    className="vw-confetti-piece absolute top-0 block w-1.5 h-3 rounded-[1px]"
                    style={{
                        left: p.left,
                        backgroundColor: p.color,
                        animationDelay: p.delay,
                        ['--vw-dx' as string]: p.dx,
                        ['--vw-rot' as string]: p.rot,
                    }}
                />
            ))}
        </div>
    )
}

export function CreationSuccessBody({
    viewName,
    scopeLabel,
    isBlank,
    icon,
    graphName,
    stats,
}: {
    viewName: string
    scopeLabel?: string
    isBlank: boolean
    /** The icon the user picked — shown back to them on the thing they just made. */
    icon?: string
    /** Blank models: the physical graph key the model now owns. */
    graphName?: string
    stats: CreationSummaryStat[]
}) {
    return (
        <div className="relative min-h-[440px] flex flex-col items-center justify-center text-center px-2">
            <ConfettiBurst />

            {/* Success mark, with the view's own icon riding along — the choice made
                on Basics shows up on the thing it was made for. */}
            <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 18 }}
                className="relative"
            >
                <div
                    aria-hidden
                    className="absolute -inset-5 rounded-full bg-emerald-500/15 blur-2xl"
                />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                    <Check className="w-8 h-8 text-white" strokeWidth={3} />
                </div>
                {icon && (
                    <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.22, type: 'spring', stiffness: 420, damping: 20 }}
                        className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center justify-center text-slate-600 dark:text-slate-300"
                    >
                        <DynamicIcon name={icon} className="w-3.5 h-3.5" />
                    </motion.span>
                )}
            </motion.div>

            <motion.h3
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 }}
                className="mt-7 text-2xl font-bold text-slate-900 dark:text-white"
            >
                {isBlank ? 'Your model is ready' : 'Your view is ready'}
            </motion.h3>

            <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="mt-2 max-w-xl text-sm text-slate-500 break-words"
            >
                <span className="font-semibold text-slate-700 dark:text-slate-300">{viewName}</span>
                {scopeLabel && <span className="text-slate-400"> · {scopeLabel}</span>}
            </motion.p>

            {/* Blank models get a real, permanent graph key — worth showing, because it
                is the one thing here that can never be renamed. */}
            {isBlank && graphName && (
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.15 }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1"
                >
                    <Database className="w-3 h-3 text-slate-400 shrink-0" />
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 break-all">
                        {graphName}
                    </span>
                </motion.p>
            )}

            {stats.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.18 }}
                    className="mt-7 flex flex-wrap items-stretch justify-center gap-3 w-full max-w-2xl"
                >
                    {stats.map(stat => {
                        const numeric = typeof stat.value === 'number'
                        return (
                            <div
                                key={stat.label}
                                // Sized to its content, not squeezed into an equal share —
                                // "Context View" was rendering as "Context …".
                                className="min-w-[132px] flex-1 basis-[132px] max-w-[200px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/40 px-4 py-3 text-left"
                            >
                                <p className={cn(
                                    'font-bold text-slate-800 dark:text-slate-200 leading-snug break-words',
                                    numeric ? 'text-xl tabular-nums' : 'text-sm capitalize',
                                )}>
                                    {stat.value}
                                </p>
                                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                    {stat.label}
                                </p>
                            </div>
                        )
                    })}
                </motion.div>
            )}

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.22 }}
                className="mt-7 inline-flex items-center gap-1.5 text-xs text-slate-400"
            >
                <Compass className="w-3.5 h-3.5" />
                Saved — you’ll always find it in Explorer
            </motion.p>
        </div>
    )
}

export function CreationSuccessFooter({
    remaining,
    onOpenNow,
    onStayHere,
}: {
    remaining: number
    onOpenNow: () => void
    onStayHere: () => void
}) {
    const counting = remaining >= 0
    // Drains left→right as the seconds run out.
    const pct = counting ? Math.max(0, Math.min(1, remaining / AUTO_OPEN_SECONDS)) * 100 : 0

    return (
        <div className="flex items-center justify-between w-full gap-4">
            <p className="text-xs text-slate-400 min-w-0">
                {counting
                    ? <>Opening automatically in <span className="font-semibold text-slate-500 dark:text-slate-300 tabular-nums">{remaining}s</span></>
                    : 'Open it whenever you’re ready'}
            </p>

            <div className="flex items-center gap-3 shrink-0">
                <button
                    type="button"
                    onClick={onStayHere}
                    className="px-5 py-2.5 rounded-xl font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors duration-150"
                >
                    Stay here
                </button>

                {/* The countdown lives INSIDE the primary action: the button visibly
                    fills as the seconds run out, so the thing about to happen and the
                    thing you'd click are the same object. */}
                <button
                    type="button"
                    onClick={onOpenNow}
                    autoFocus
                    className="relative overflow-hidden flex items-center gap-2 px-6 py-2.5 rounded-xl font-semibold text-white shadow-lg shadow-blue-600/20 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 transition-colors duration-150"
                >
                    {counting && (
                        <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-1000 ease-linear"
                            style={{ width: `${pct}%` }}
                        />
                    )}
                    <span className="relative flex items-center gap-2">
                        Open view now
                        <ArrowRight className="w-4 h-4" />
                    </span>
                </button>
            </div>
        </div>
    )
}
