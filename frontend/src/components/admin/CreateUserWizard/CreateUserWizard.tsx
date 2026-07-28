/**
 * CreateUserWizard — provisioning an account directly.
 *
 * Same shell as the invite wizard and the house wizards before it. The
 * questions differ because the job does: an invite asks who the LINK is
 * for and ends in a URL to send; this asks who the PERSON is and ends in
 * an account that already exists.
 *
 *   1. Who    — one person, or a pasted list
 *   2. Access — role, workspace, groups (the invite rules, shared)
 *   3. Sign-in— how they first get in
 *   4. Review — then the accounts, with their setup links
 */
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    UserPlus, Check, ChevronLeft, ChevronRight, X, Loader2, AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useWizardKeyboard } from '@/components/admin/AssetOnboardingWizard/hooks/useWizardKeyboard'
import type { CreatedUser, BulkCreateUsersResponse } from '@/services/adminUserService'

import { useCreateUser, type CreateStep } from './useCreateUser'
import { PeopleStep } from './steps/PeopleStep'
import { UserAccessStep } from './steps/UserAccessStep'
import { SignInStep } from './steps/SignInStep'
import { UserReviewStep } from './steps/UserReviewStep'
import { UserSuccessPhase } from './steps/UserSuccessPhase'

const STEPS: { id: CreateStep; title: string }[] = [
    { id: 'people', title: 'Who' },
    { id: 'access', title: 'Access' },
    { id: 'signin', title: 'Sign-in' },
    { id: 'review', title: 'Review' },
]

export function CreateUserWizard({
    canGrantSuperAdmin, loading, error, result, bulkResult,
    onSubmit, onSubmitBulk, onAnother, onClose,
}: {
    canGrantSuperAdmin: boolean
    loading: boolean
    error: string | null
    result: CreatedUser | null
    bulkResult: BulkCreateUsersResponse | null
    onSubmit: (body: ReturnType<ReturnType<typeof useCreateUser>['buildPayload']>) => void
    onSubmitBulk: (body: ReturnType<ReturnType<typeof useCreateUser>['buildPayload']>) => void
    onAnother: () => void
    onClose: () => void
}) {
    const w = useCreateUser({ canGrantSuperAdmin })
    const modalRef = useRef<HTMLDivElement>(null)
    const [showCloseConfirm, setShowCloseConfirm] = useState(false)
    const [direction, setDirection] = useState(1)

    const succeeded = Boolean(result || bulkResult)
    const idx = STEPS.findIndex(s => s.id === w.step)
    const isLast = idx === STEPS.length - 1

    const goTo = useCallback((next: CreateStep) => {
        setDirection(STEPS.findIndex(s => s.id === next) > idx ? 1 : -1)
        w.setStep(next)
    }, [idx, w])

    const goNext = useCallback(() => {
        if (!w.canAdvance || isLast) return
        goTo(STEPS[idx + 1].id)
    }, [w.canAdvance, isLast, idx, goTo])

    const submit = useCallback(() => {
        const payload = w.buildPayload()
        if (!payload) return
        if (payload.kind === 'bulk') onSubmitBulk(payload)
        else onSubmit(payload)
    }, [w, onSubmit, onSubmitBulk])

    const dirty = w.email.trim() !== '' || w.bulkText.trim() !== ''
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

    const summaryOf = (id: CreateStep): string | null => (
        id === 'people' ? w.peopleSummary
        : id === 'access' ? w.accessSummary
        : id === 'signin' ? w.signinSummary
        : null
    )

    return (
        <>
            <Backdrop open zClassName="z-[60]" className="bg-black/60" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center pointer-events-none">
                <motion.div
                    ref={modalRef}
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ duration: 0.12 }}
                    className="pointer-events-auto w-full max-w-4xl mx-4 bg-canvas-elevated rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
                >
                    <div className="flex items-center justify-between px-8 py-5 border-b border-black/[0.08] dark:border-white/[0.10] bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02] shrink-0">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-md shrink-0">
                                <UserPlus className="w-6 h-6" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-ink">Add people</h2>
                                <p className="text-sm text-ink-muted">
                                    {succeeded
                                        ? bulkResult
                                            ? `${bulkResult.created} account${bulkResult.created === 1 ? '' : 's'} created`
                                            : 'Account created'
                                        : `Step ${idx + 1} of ${STEPS.length}: ${STEPS[idx]?.title}`}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={requestClose}
                            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            aria-label="Close add-people wizard"
                        >
                            <X className="w-5 h-5 text-ink-muted" />
                        </button>
                    </div>

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
                                                            ? 'bg-emerald-600 text-white shadow-md ring-2 ring-emerald-100 dark:ring-emerald-900'
                                                            : done
                                                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 cursor-pointer'
                                                                : 'text-ink-muted cursor-not-allowed',
                                                    )}
                                                >
                                                    {done ? <Check className="w-4 h-4" /> : (
                                                        <span className={cn(
                                                            'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                                            current ? 'border-transparent bg-white/20' : 'border-black/[0.12] dark:border-white/[0.15]',
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
                                {succeeded ? (
                                    <UserSuccessPhase result={result} bulkResult={bulkResult} />
                                ) : w.step === 'people' ? (
                                    <PeopleStep w={w} />
                                ) : w.step === 'access' ? (
                                    <UserAccessStep w={w} />
                                ) : w.step === 'signin' ? (
                                    <SignInStep w={w} />
                                ) : (
                                    <UserReviewStep w={w} onEdit={goTo} />
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {error && !succeeded && (
                        <div className="mx-8 mb-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400 shrink-0">
                            {error}
                        </div>
                    )}

                    {!succeeded && w.warnings.length > 0 && (
                        <div className="mx-8 mb-2 px-4 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20 space-y-1 shrink-0">
                            {w.warnings.map((wm, i) => (
                                <div key={i} className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400">
                                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                    <span>{wm}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {succeeded ? (
                        <div className="flex items-center justify-end gap-3 px-8 py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <button
                                onClick={onAnother}
                                className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                            >
                                Add more
                            </button>
                            <button
                                onClick={onClose}
                                className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:brightness-110 shadow-md transition-colors duration-150"
                            >
                                <Check className="w-4 h-4" />
                                Done
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between px-8 py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <button
                                onClick={() => idx > 0 && goTo(STEPS[idx - 1].id)}
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
                                            ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:brightness-110 shadow-md'
                                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                    )}
                                >
                                    {loading ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
                                    ) : isLast ? (
                                        <><UserPlus className="w-4 h-4" /> {w.submitLabel}</>
                                    ) : (
                                        <>Next <ChevronRight className="w-4 h-4" /></>
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                </motion.div>
            </div>

            <Backdrop open={showCloseConfirm} zClassName="z-[70]" className="bg-black/40" />
            <div className="fixed inset-0 z-[71] flex items-center justify-center pointer-events-none">
                <AnimatePresence>
                    {showCloseConfirm && (
                        <motion.div
                            key="create-user-close-confirm"
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
                                    <h3 className="text-sm font-semibold text-ink">Discard these accounts?</h3>
                                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                                        Nothing has been created yet. Closing loses what you have entered.
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

export default CreateUserWizard
