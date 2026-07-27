/**
 * InviteWizard — creating an invite link, as a wizard.
 *
 * Follows the house pattern set by ViewWizard and AssetOnboardingWizard:
 * its own overlay rather than a card inside another modal, a gradient
 * header stating step N of M, a progress rail whose completed steps carry
 * a one-line summary of what you chose and can be clicked to go back,
 * directional step transitions, keyboard navigation with a focus trap, an
 * unsaved-changes guard, and a success phase in place of the last step.
 *
 * The order of the questions is the design. The dialog this replaces put
 * seven of them on one screen with no starting point, and left the
 * sentence describing the whole invite below the fold, under the fields it
 * was meant to check. Here:
 *
 *   1. Who it's for   — the only question that constrains the others, and
 *                       the one the inviter can already answer. It carries
 *                       the defaults for everything downstream.
 *   2. What they get  — role, workspace, groups.
 *   3. Safety         — expiry and seats, with the exposure they add up to.
 *   4. Review         — the receipt, then the link.
 */
import { useState, useMemo, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Link2, Users, ShieldCheck, Check, ChevronLeft, ChevronRight, X,
    Loader2, AlertTriangle, Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useWizardKeyboard } from '@/components/admin/AssetOnboardingWizard/hooks/useWizardKeyboard'
import type { CreateInviteOptions, InviteResponse, BulkInviteResponse } from '@/services/adminUserService'

import { useInviteWizard, type WizardStep } from './useInviteWizard'
import { AudienceStep } from './steps/AudienceStep'
import { AccessStep } from './steps/AccessStep'
import { SafetyStep } from './steps/SafetyStep'
import { ReviewStep } from './steps/ReviewStep'
import { BulkInviteResultList } from './results'
import { SuccessPhase } from './steps/SuccessPhase'

const STEPS: { id: WizardStep; title: string; icon: typeof Users }[] = [
    { id: 'audience', title: "Who it's for", icon: Users },
    { id: 'access', title: 'What they get', icon: ShieldCheck },
    { id: 'safety', title: 'Safety', icon: Link2 },
    { id: 'review', title: 'Review', icon: Check },
]

export function InviteWizard({
    canGrantSuperAdmin, loading, result, bulkResult, inviteUrl, copied,
    onCopy, onSubmit, onSubmitBulk, onAnother, onClose,
}: {
    canGrantSuperAdmin: boolean
    loading: boolean
    result: InviteResponse | null
    bulkResult: BulkInviteResponse | null
    inviteUrl: string
    copied: boolean
    onCopy: () => void
    onSubmit: (role: string | null, opts: CreateInviteOptions) => void
    onSubmitBulk: (emails: string[], role: string | null, opts: CreateInviteOptions) => void
    onAnother: () => void
    onClose: () => void
}) {
    const w = useInviteWizard({ canGrantSuperAdmin })
    const modalRef = useRef<HTMLDivElement>(null)
    const [showCloseConfirm, setShowCloseConfirm] = useState(false)
    // 1 forward, -1 back — so a step you are returning to slides in from
    // the side you left it on.
    const [direction, setDirection] = useState(1)

    const succeeded = Boolean(result || bulkResult)
    const idx = STEPS.findIndex(s => s.id === w.step)
    const isLast = idx === STEPS.length - 1

    const goTo = useCallback((next: WizardStep) => {
        const to = STEPS.findIndex(s => s.id === next)
        setDirection(to > idx ? 1 : -1)
        w.setStep(next)
    }, [idx, w])

    const goNext = useCallback(() => {
        if (!w.canAdvance || isLast) return
        goTo(STEPS[idx + 1].id)
    }, [w.canAdvance, isLast, idx, goTo])

    const goBack = useCallback(() => {
        if (idx === 0) return
        goTo(STEPS[idx - 1].id)
    }, [idx, goTo])

    const submit = useCallback(() => {
        const payload = w.buildPayload()
        if (!payload) return
        if (payload.kind === 'bulk') onSubmitBulk(payload.emails, payload.role, payload.opts)
        else onSubmit(payload.role, payload.opts)
    }, [w, onSubmit, onSubmitBulk])

    // Anything typed or chosen is worth a confirm on the way out. Nothing
    // chosen yet is not — that turns Escape into a nuisance.
    const dirty = w.audience !== null
    const requestClose = useCallback(() => {
        if (succeeded || !dirty) { onClose(); return }
        setShowCloseConfirm(true)
    }, [succeeded, dirty, onClose])

    useWizardKeyboard({
        containerRef: modalRef,
        onClose: requestClose,
        onNext: goNext,
        onSubmit: submit,
        canProceed: w.canAdvance,
        isLastStep: isLast,
        isSubmitting: loading,
        isSuccess: succeeded,
        isOpen: true,
    })

    /** What a completed step chose, in a few words, under its rail pill.
     *  A progress rail that only says "done" makes you walk back to find
     *  out what you picked. */
    const summaryOf = (id: WizardStep): string | null => {
        switch (id) {
            case 'audience': return w.audienceSummary
            case 'access': return w.accessSummary
            case 'safety': return w.safetySummary
            default: return null
        }
    }

    const stepWarnings = useMemo(() => w.warnings, [w.warnings])

    return (
        <>
            {/* Plain CSS transition, never inside AnimatePresence — a stranded
                fixed-inset-0 node under StrictMode eats clicks. */}
            <Backdrop open zClassName="z-[60]" className="bg-black/60" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center pointer-events-none">
                <motion.div
                    ref={modalRef}
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ duration: 0.12 }}
                    className="pointer-events-auto w-full max-w-4xl mx-4 bg-canvas-elevated rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
                >
                    {/* ── Header ─────────────────────────────────────── */}
                    <div className="flex items-center justify-between px-8 py-5 border-b border-black/[0.08] dark:border-white/[0.10] bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02] shrink-0">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md shrink-0">
                                <Link2 className="w-6 h-6" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-ink">Invite by link</h2>
                                <p className="text-sm text-ink-muted">
                                    {succeeded
                                        ? bulkResult
                                            ? `${bulkResult.created} link${bulkResult.created === 1 ? '' : 's'} ready to send`
                                            : 'Your link is ready'
                                        : `Step ${idx + 1} of ${STEPS.length}: ${STEPS[idx]?.title}`}
                                </p>
                            </div>
                        </div>
                        {/* Labelled, not just titled: a bare X reading as
                            "Cancel" is indistinguishable from the footer's
                            Cancel button to anything that navigates by name. */}
                        <button
                            onClick={requestClose}
                            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            aria-label="Close invite wizard"
                            title={succeeded ? 'Close' : 'Cancel'}
                        >
                            <X className="w-5 h-5 text-ink-muted" />
                        </button>
                    </div>

                    {/* ── Progress rail ──────────────────────────────── */}
                    {!succeeded && (
                        <div className="px-8 py-4 bg-black/[0.02] dark:bg-white/[0.02] border-b border-black/[0.08] dark:border-white/[0.10] shrink-0 overflow-x-auto">
                            <div className="flex items-center gap-2 min-w-max">
                                {STEPS.map((s, i) => {
                                    const done = i < idx
                                    const current = i === idx
                                    const summary = done ? summaryOf(s.id) : null
                                    return (
                                        <div key={s.id} className="flex items-center">
                                            <div className="flex flex-col items-center">
                                                <button
                                                    onClick={() => done && goTo(s.id)}
                                                    disabled={!done}
                                                    className={cn(
                                                        'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-150',
                                                        current
                                                            ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-100 dark:ring-indigo-900'
                                                            : done
                                                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 cursor-pointer'
                                                                : 'text-ink-muted cursor-not-allowed',
                                                    )}
                                                >
                                                    {done ? <Check className="w-4 h-4" /> : (
                                                        <span className={cn(
                                                            'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                                            current
                                                                ? 'border-transparent bg-white/20'
                                                                : 'border-black/[0.12] dark:border-white/[0.15]',
                                                        )}>
                                                            {i + 1}
                                                        </span>
                                                    )}
                                                    {s.title}
                                                </button>
                                                {summary && (
                                                    <span className="text-[9px] text-emerald-600/70 dark:text-emerald-400/60 font-medium mt-0.5 max-w-[130px] truncate">
                                                        {summary}
                                                    </span>
                                                )}
                                            </div>
                                            {i < STEPS.length - 1 && (
                                                <div className={cn(
                                                    'w-8 h-px mx-2',
                                                    done ? 'bg-emerald-400' : 'bg-black/[0.10] dark:bg-white/[0.12]',
                                                )} />
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* ── Step content ───────────────────────────────── */}
                    <div className="flex-1 overflow-y-auto min-h-[440px]">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={succeeded ? 'success' : w.step}
                                initial={{ opacity: 0, x: direction * 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: direction * -20 }}
                                transition={{ duration: 0.06 }}
                                className="p-8"
                            >
                                {bulkResult ? (
                                    <BulkInviteResultList
                                        result={bulkResult}
                                        onAnother={onAnother}
                                        onClose={onClose}
                                    />
                                ) : result ? (
                                    <SuccessPhase
                                        result={result}
                                        inviteUrl={inviteUrl}
                                        copied={copied}
                                        onCopy={onCopy}
                                        expiresLabel={w.expiresIn}
                                    />
                                ) : w.step === 'audience' ? (
                                    <AudienceStep w={w} />
                                ) : w.step === 'access' ? (
                                    <AccessStep w={w} onFixAudience={() => goTo('audience')} />
                                ) : w.step === 'safety' ? (
                                    <SafetyStep w={w} />
                                ) : (
                                    <ReviewStep w={w} onEdit={goTo} />
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* ── Non-blocking warnings ──────────────────────── */}
                    {!succeeded && stepWarnings.length > 0 && (
                        <div className="mx-8 mb-2 px-4 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20 space-y-1 shrink-0">
                            {stepWarnings.map((wm, i) => (
                                <div key={i} className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400">
                                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                    <span>{wm}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ── Success footer. A success screen whose only way
                        out is the X leaves the user hunting for the exit. ── */}
                    {succeeded && !bulkResult && (
                        <div className="flex items-center justify-end gap-3 px-8 py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <button
                                onClick={onAnother}
                                className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                            >
                                Create another
                            </button>
                            <button
                                onClick={onClose}
                                className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md transition-colors duration-150"
                            >
                                <Check className="w-4 h-4" />
                                Done
                            </button>
                        </div>
                    )}

                    {/* ── Footer ─────────────────────────────────────── */}
                    {!succeeded && (
                        <div className="flex items-center justify-between px-8 py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <button
                                onClick={goBack}
                                disabled={idx === 0}
                                className={cn(
                                    'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    idx > 0
                                        ? 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5'
                                        : 'text-ink-muted cursor-not-allowed',
                                )}
                            >
                                <ChevronLeft className="w-4 h-4" />
                                Back
                            </button>

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={requestClose}
                                    className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={isLast ? submit : goNext}
                                    disabled={!w.canAdvance || loading}
                                    className={cn(
                                        'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                        w.canAdvance && !loading
                                            ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                    )}
                                >
                                    {loading ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
                                    ) : isLast ? (
                                        <><Send className="w-4 h-4" /> {w.generateLabel}</>
                                    ) : (
                                        <>Next <ChevronRight className="w-4 h-4" /></>
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                </motion.div>
            </div>

            {/* ── Discard guard ──────────────────────────────────────── */}
            <Backdrop open={showCloseConfirm} zClassName="z-[70]" className="bg-black/40" />
            <div className="fixed inset-0 z-[71] flex items-center justify-center pointer-events-none">
                <AnimatePresence>
                    {showCloseConfirm && (
                        <motion.div
                            key="invite-close-confirm"
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="pointer-events-auto bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] rounded-xl shadow-lg p-6 max-w-sm mx-4 space-y-4"
                        >
                            <div className="flex items-start gap-3">
                                <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-ink">Discard this invite?</h3>
                                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                                        No link has been created yet. Closing loses what you have chosen.
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-3">
                                <button
                                    onClick={() => setShowCloseConfirm(false)}
                                    className="px-4 py-2 rounded-lg text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                    Keep editing
                                </button>
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors"
                                >
                                    Discard
                                </button>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </>
    )
}

export default InviteWizard
