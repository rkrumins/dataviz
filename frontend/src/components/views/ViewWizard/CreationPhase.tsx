/**
 * CreationPhase — what the wizard shows AFTER "Create View" is clicked.
 *
 * Creating a view is several sequential HTTP calls (blank models add graph
 * provisioning, which can wait on a cold provider). The wizard used to show a
 * spinner on the footer button and nothing else, so a multi-second create read
 * as a hang — people clicked again.
 *
 * Stages are one row per awaited call, because that is genuinely all the
 * frontend can observe. We do NOT invent sub-steps we can't see.
 *
 * On success the view is already usable: the success card offers to open it now
 * and, if you do nothing, opens it for you after a short countdown (paused
 * while the pointer is over the card, cancelled by any click).
 */

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, ArrowRight, Check, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'

// ─── Types ──────────────────────────────────────────────────────────────────

export type CreationStageId = 'provision' | 'create' | 'layout'
export type CreationStageState = 'pending' | 'active' | 'done' | 'failed'

export interface CreationStage {
    id: CreationStageId
    label: string
    detail?: string
    state: CreationStageState
}

/** Seconds the success card waits before opening the view on your behalf. */
const AUTO_OPEN_SECONDS = 5

// ─── Shell ──────────────────────────────────────────────────────────────────

const PHASE_KEYFRAMES = `
@keyframes vw-confetti-fall {
  0%   { transform: translate3d(0, -10px, 0) rotate(0deg); opacity: 1; }
  100% { transform: translate3d(var(--vw-dx), 190px, 0) rotate(var(--vw-rot)); opacity: 0; }
}
.vw-confetti-piece { animation: vw-confetti-fall 1.15s ease-out forwards; }
@media (prefers-reduced-motion: reduce) {
  .vw-confetti-piece { display: none; }
}
`

function PhaseShell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
    return (
        <>
            {/* Sibling of the pointer-events-none wrapper — never nested inside it. */}
            <Backdrop open={true} zClassName="z-50" className="bg-black/60" />
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <style>{PHASE_KEYFRAMES}</style>
                <motion.div
                    initial={{ scale: 0.96, opacity: 0, y: 16 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ duration: 0.14 }}
                    className="pointer-events-auto relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden"
                >
                    {onClose && (
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            <X className="w-4 h-4 text-slate-500" />
                        </button>
                    )}
                    {children}
                </motion.div>
            </div>
        </>
    )
}

// ─── Progress ───────────────────────────────────────────────────────────────

function StageRow({ stage }: { stage: CreationStage }) {
    const icon = {
        done: <Check className="w-3.5 h-3.5 text-white" />,
        active: <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />,
        failed: <AlertCircle className="w-3.5 h-3.5 text-white" />,
        pending: <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />,
    }[stage.state]

    const dotClass = {
        done: 'bg-emerald-500',
        active: 'bg-blue-500',
        failed: 'bg-red-500',
        pending: 'bg-slate-200 dark:bg-slate-700',
    }[stage.state]

    return (
        <div className="flex items-start gap-3">
            <div className={cn('w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-colors', dotClass)}>
                {icon}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
                <p className={cn(
                    'text-sm font-medium transition-colors',
                    stage.state === 'pending'
                        ? 'text-slate-400'
                        : stage.state === 'failed'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-slate-800 dark:text-slate-200',
                )}>
                    {stage.label}
                </p>
                {stage.detail && stage.state !== 'pending' && (
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{stage.detail}</p>
                )}
            </div>
        </div>
    )
}

export function CreationProgress({
    stages,
    viewName,
    error,
    onRetry,
    onBack,
}: {
    stages: CreationStage[]
    viewName: string
    error: string | null
    onRetry: () => void
    onBack: () => void
}) {
    return (
        <PhaseShell>
            <div className="px-8 pt-8 pb-6">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    {error ? 'Couldn’t finish creating your view' : 'Creating your view'}
                </h2>
                <p className="text-sm text-slate-500 mt-0.5 truncate" title={viewName}>{viewName}</p>

                <div className="mt-6 space-y-4">
                    {stages.map(stage => <StageRow key={stage.id} stage={stage} />)}
                </div>

                {error && (
                    <div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                        <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">{error}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                            Nothing was lost — retrying picks up exactly where it stopped.
                        </p>
                    </div>
                )}
            </div>

            {error && (
                <div className="flex items-center justify-end gap-3 px-8 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    <button
                        onClick={onBack}
                        className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                        Back to review
                    </button>
                    <button
                        onClick={onRetry}
                        className="px-5 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md transition-colors"
                    >
                        Retry
                    </button>
                </div>
            )}
        </PhaseShell>
    )
}

// ─── Success ────────────────────────────────────────────────────────────────

/** Deterministic confetti — no layout thrash, transform/opacity only. */
const CONFETTI = [
    { dx: '-58px', rot: '-140deg', delay: '0ms', color: '#3b82f6', left: '18%' },
    { dx: '34px', rot: '120deg', delay: '40ms', color: '#8b5cf6', left: '30%' },
    { dx: '-18px', rot: '200deg', delay: '90ms', color: '#22c55e', left: '42%' },
    { dx: '52px', rot: '-95deg', delay: '20ms', color: '#f59e0b', left: '54%' },
    { dx: '-42px', rot: '160deg', delay: '120ms', color: '#ec4899', left: '66%' },
    { dx: '22px', rot: '-180deg', delay: '70ms', color: '#06b6d4', left: '78%' },
    { dx: '-8px', rot: '90deg', delay: '150ms', color: '#6366f1', left: '24%' },
    { dx: '46px', rot: '140deg', delay: '110ms', color: '#22c55e', left: '72%' },
]

function ConfettiBurst() {
    return (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 overflow-hidden">
            {CONFETTI.map((p, i) => (
                <span
                    key={i}
                    className="vw-confetti-piece absolute top-6 block w-1.5 h-2.5 rounded-[1px]"
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

export function CreationSuccess({
    viewName,
    scopeLabel,
    isBlank,
    onOpenNow,
    onClose,
}: {
    viewName: string
    scopeLabel?: string
    isBlank: boolean
    onOpenNow: () => void
    onClose: () => void
}) {
    const [remaining, setRemaining] = useState(AUTO_OPEN_SECONDS)
    const [paused, setPaused] = useState(false)

    // Auto-open unless the user is clearly still reading (pointer over the card)
    // or has taken an action themselves.
    useEffect(() => {
        if (paused || remaining < 0) return
        if (remaining === 0) {
            onOpenNow()
            return
        }
        const t = setTimeout(() => setRemaining(r => r - 1), 1000)
        return () => clearTimeout(t)
    }, [remaining, paused, onOpenNow])

    const cancelAuto = useCallback(() => setRemaining(-1), [])

    const handleOpen = useCallback(() => {
        cancelAuto()
        onOpenNow()
    }, [cancelAuto, onOpenNow])

    const handleClose = useCallback(() => {
        cancelAuto()
        onClose()
    }, [cancelAuto, onClose])

    const autoRunning = remaining >= 0 && !paused

    return (
        <PhaseShell onClose={handleClose}>
            <div
                onMouseEnter={() => setPaused(true)}
                onMouseLeave={() => setPaused(false)}
                className="relative px-8 pt-10 pb-8 text-center"
            >
                <ConfettiBurst />

                <motion.div
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 18 }}
                    className="relative mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25"
                >
                    <Check className="w-7 h-7 text-white" strokeWidth={3} />
                </motion.div>

                <h2 className="mt-5 text-xl font-bold text-slate-900 dark:text-white">
                    {isBlank ? 'Your model is ready' : 'View created'}
                </h2>
                <p className="mt-1 text-sm text-slate-500 truncate" title={viewName}>
                    <span className="font-semibold text-slate-700 dark:text-slate-300">{viewName}</span>
                    {scopeLabel && <span className="text-slate-400"> · {scopeLabel}</span>}
                </p>

                <button
                    onClick={handleOpen}
                    className="mt-6 inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md transition-colors"
                >
                    Open view now
                    <ArrowRight className="w-4 h-4" />
                </button>

                <div className="mt-4 h-4">
                    {remaining >= 0 ? (
                        <p className="text-[11px] text-slate-400">
                            {paused
                                ? 'Auto-open paused'
                                : `Opening automatically in ${remaining}s`}
                        </p>
                    ) : (
                        <button
                            onClick={handleClose}
                            className="text-[11px] font-medium text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                        >
                            Stay here
                        </button>
                    )}
                </div>
            </div>

            {/* Countdown rail — freezes on hover so it never yanks the page away. */}
            <div className="h-1 w-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                {remaining >= 0 && (
                    <motion.div
                        className="h-full bg-gradient-to-r from-blue-500 to-indigo-600"
                        initial={{ width: '100%' }}
                        animate={{ width: autoRunning ? '0%' : `${(Math.max(remaining, 0) / AUTO_OPEN_SECONDS) * 100}%` }}
                        transition={{ duration: autoRunning ? remaining : 0, ease: 'linear' }}
                    />
                )}
            </div>
        </PhaseShell>
    )
}
