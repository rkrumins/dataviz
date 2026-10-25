/**
 * ApiKeyWizard — making a key, one decision at a time.
 *
 * The house wizard frame (CreateUserWizard's, copied as each wizard does):
 * a stepper whose finished steps can be revisited and say what was chosen,
 * steps that slide in the direction you are going, a question before a
 * half-filled form is thrown away, and Escape / Cmd-Enter from
 * `useWizardKeyboard`.
 *
 *   1. Purpose     — what the key is for (a preset), its name
 *   2. Reach       — selected items, whole workspaces, or everything
 *   3. Permissions — what it may do there
 *   4. Safety      — how long it lasts, which networks it answers
 *   5. Review      — what it will do, how far it reaches, confirm it's you
 *   → the token, once
 *
 * Above the detail drawer and the page (z-[80]); its confirmations above it.
 */
import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronLeft, ChevronRight, KeySquare, Loader2, ShieldAlert, X } from 'lucide-react'

import { useWizardKeyboard } from '@/components/admin/AssetOnboardingWizard/hooks/useWizardKeyboard'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { ApiKeyOptions } from '@/services/apiKeyService'
import { CloseConfirm } from '../CloseConfirm'
import { RevealPanel } from '../RevealPanel'
import { StepUpField } from '../StepUpField'
import type { ApiKeyDraft, WizardStep } from '../apiKeyDraft'
import { useKeyAccount } from '../keyClient'
import { STEPS, useApiKeyWizard } from './useApiKeyWizard'
import { PermissionsStep } from './steps/PermissionsStep'
import { PurposeStep } from './steps/PurposeStep'
import { ReachStep } from './steps/ReachStep'
import { ReviewStep } from './steps/ReviewStep'
import { SafetyStep } from './steps/SafetyStep'

export function ApiKeyWizard({ options, resumed, onClose, onCreated }: {
    options: ApiKeyOptions
    /** A draft parked before an identity-provider sign-in: opens at its step. */
    resumed?: ApiKeyDraft | null
    onClose: () => void
    /** A key now exists: the page should show it. Called as the wizard closes. */
    onCreated: () => void
}) {
    const w = useApiKeyWizard({ options, resumed })
    const account = useKeyAccount()
    const modalRef = useRef<HTMLDivElement>(null)
    const [direction, setDirection] = useState(1)
    const [confirm, setConfirm] = useState<'discard' | 'unstored' | null>(null)
    const [acknowledged, setAcknowledged] = useState(false)

    const succeeded = w.created !== null
    // Nothing to fill in when the server will refuse it anyway — say so first.
    const blocked = !options.stepUpAvailable && !succeeded
    const idx = STEPS.findIndex((s) => s.id === w.step)
    const isLast = idx === STEPS.length - 1

    const goTo = useCallback((next: WizardStep) => {
        setDirection(STEPS.findIndex((s) => s.id === next) > idx ? 1 : -1)
        w.setStep(next)
    }, [idx, w])

    const goNext = useCallback(() => {
        if (!w.canAdvance || isLast) return
        goTo(STEPS[idx + 1].id)
    }, [w.canAdvance, isLast, idx, goTo])

    const finish = useCallback(() => {
        onCreated()
        onClose()
    }, [onCreated, onClose])

    const requestClose = useCallback(() => {
        if (confirm) { setConfirm(null); return }
        if (w.busy) return
        if (succeeded) {
            if (acknowledged) finish()
            else setConfirm('unstored')
            return
        }
        if (w.dirty && !blocked) { setConfirm('discard'); return }
        onClose()
    }, [confirm, w.busy, w.dirty, succeeded, acknowledged, blocked, finish, onClose])

    useWizardKeyboard({
        containerRef: modalRef,
        onClose: requestClose,
        onNext: goNext,
        onSubmit: () => void w.submit(),
        canProceed: w.canAdvance && !blocked,
        isLastStep: isLast,
        isSubmitting: w.busy,
        isSuccess: succeeded,
        isOpen: true,
    })

    return createPortal(
        <>
            <Backdrop open zClassName="z-[80]" className="bg-black/60" />
            <div className="fixed inset-0 z-[81] flex items-center justify-center pointer-events-none">
                <motion.div
                    ref={modalRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="api-key-wizard-title"
                    initial={{ scale: 0.96, opacity: 0, y: 16 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={MOTION.modalSpring}
                    className="pointer-events-auto w-full h-full sm:h-auto sm:max-w-4xl sm:mx-4 sm:max-h-[90vh] bg-canvas-elevated sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
                >
                    <div className="flex items-center justify-between gap-3 px-5 sm:px-8 py-4 sm:py-5 border-b border-black/[0.08] dark:border-white/[0.10] bg-gradient-to-r from-indigo-500/[0.05] via-violet-500/[0.03] to-transparent shrink-0">
                        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 shrink-0">
                                <KeySquare className="w-6 h-6" aria-hidden />
                            </div>
                            <div className="min-w-0">
                                <h2 id="api-key-wizard-title" className="text-lg sm:text-xl font-bold text-ink truncate">
                                    {account
                                        ? (succeeded ? `New key for “${account.name}”` : `Create a key for “${account.name}”`)
                                        : (succeeded ? 'Your new key' : 'Create an API key')}
                                </h2>
                                <p className="text-xs sm:text-sm text-ink-muted truncate">
                                    {succeeded
                                        ? 'Copy it now — it won’t be shown again'
                                        : blocked
                                            ? 'Not from this sign-in'
                                            : `Step ${idx + 1} of ${STEPS.length}: ${STEPS[idx]?.title}`}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={requestClose}
                            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors shrink-0"
                            aria-label="Close the key wizard"
                        >
                            <X className="w-5 h-5 text-ink-muted" />
                        </button>
                    </div>

                    {!succeeded && !blocked && (
                        <Stepper current={idx} summaries={w.summaries} onGoTo={goTo} />
                    )}

                    <div className="flex-1 overflow-y-auto sm:min-h-[460px]">
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={succeeded ? 'reveal' : blocked ? 'blocked' : w.step}
                                initial={{ opacity: 0, x: direction * 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: direction * -20 }}
                                transition={MOTION.stepSwap}
                                className="px-5 py-6 sm:p-8"
                            >
                                {succeeded && w.created ? (
                                    <RevealPanel created={w.created} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
                                ) : blocked ? (
                                    <div className="max-w-xl mx-auto py-6">
                                        <StepUpField stepUp={options.stepUp} available={false} reason={options.stepUpReason} password="" onPasswordChange={() => {}} />
                                    </div>
                                ) : w.step === 'purpose' ? (
                                    <PurposeStep w={w} options={options} />
                                ) : w.step === 'reach' ? (
                                    <ReachStep w={w} options={options} />
                                ) : w.step === 'permissions' ? (
                                    <PermissionsStep w={w} />
                                ) : w.step === 'safety' ? (
                                    <SafetyStep w={w} options={options} />
                                ) : (
                                    <ReviewStep w={w} options={options} onEdit={goTo} />
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {w.error && !succeeded && (
                        <div role="alert" className="mx-5 sm:mx-8 mb-3 flex items-start gap-2 px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-sm text-rose-700 dark:text-rose-300 shrink-0">
                            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
                            {w.error}
                        </div>
                    )}

                    {succeeded ? (
                        <div className="flex items-center justify-end gap-3 px-5 sm:px-8 py-4 sm:py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <HoverTip label={acknowledged ? 'Close and see it in your list' : 'Tick “I’ve stored it somewhere safe” first'}>
                                <button
                                    type="button"
                                    onClick={finish}
                                    disabled={!acknowledged}
                                    className={cn(
                                        'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                        acknowledged
                                            ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                    )}
                                >
                                    <Check className="w-4 h-4" />
                                    Done
                                </button>
                            </HoverTip>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-2 px-5 sm:px-8 py-4 sm:py-5 border-t border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                            <button
                                type="button"
                                onClick={() => idx > 0 && goTo(STEPS[idx - 1].id)}
                                disabled={idx === 0 || blocked}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 sm:px-5 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    idx > 0 && !blocked
                                        ? 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5'
                                        : 'text-ink-muted opacity-50 cursor-not-allowed',
                                )}
                            >
                                <ChevronLeft className="w-4 h-4" />
                                Back
                            </button>
                            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                                <button
                                    type="button"
                                    onClick={requestClose}
                                    className="px-3 sm:px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                                >
                                    {blocked ? 'Close' : 'Cancel'}
                                </button>
                                {!blocked && (
                                    <button
                                        type="button"
                                        onClick={isLast ? () => void w.submit() : goNext}
                                        disabled={!w.canAdvance || w.busy}
                                        className={cn(
                                            'flex items-center gap-2 px-4 sm:px-6 py-2.5 rounded-xl font-medium transition-colors duration-150 min-w-0',
                                            w.canAdvance && !w.busy
                                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md shadow-indigo-500/20'
                                                : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                        )}
                                    >
                                        {w.busy ? (
                                            <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
                                        ) : isLast ? (
                                            <>
                                                <KeySquare className="w-4 h-4 shrink-0" />
                                                {/* A phone has room for the verb, not the whole sentence. */}
                                                {w.viaProvider && <span className="sm:hidden">Continue</span>}
                                                <span className={cn('truncate', w.viaProvider && 'hidden sm:inline')}>{w.submitLabel}</span>
                                            </>
                                        ) : (
                                            <>Next <ChevronRight className="w-4 h-4" /></>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </motion.div>
            </div>

            <CloseConfirm
                open={confirm !== null}
                title={confirm === 'unstored' ? 'Close without storing the key?' : 'Discard this key?'}
                body={confirm === 'unstored'
                    ? 'It won’t be shown again. If you haven’t copied it, you would have to rotate it to get a new one.'
                    : 'Nothing has been created yet. Closing loses what you have chosen.'}
                keepLabel={confirm === 'unstored' ? 'Go back' : 'Keep editing'}
                leaveLabel={confirm === 'unstored' ? 'Close anyway' : 'Discard'}
                onKeep={() => setConfirm(null)}
                onLeave={() => {
                    setConfirm(null)
                    if (succeeded) finish()
                    else onClose()
                }}
            />
        </>,
        document.body,
    )
}

/** Finished steps can be revisited, and say what was chosen there. */
function Stepper({ current, summaries, onGoTo }: {
    current: number
    summaries: Record<WizardStep, string | null>
    onGoTo: (step: WizardStep) => void
}) {
    return (
        <div className="px-5 sm:px-8 py-3 sm:py-4 bg-black/[0.02] dark:bg-white/[0.02] border-b border-black/[0.08] dark:border-white/[0.10] shrink-0">
            {/* A phone gets the progress, not five labels it has no room for. */}
            <div className="sm:hidden">
                <div className="flex gap-1.5" aria-hidden>
                    {STEPS.map((s, i) => (
                        <span key={s.id} className={cn(
                            'h-1.5 flex-1 rounded-full transition-colors',
                            i < current ? 'bg-indigo-400' : i === current ? 'bg-indigo-600' : 'bg-black/[0.08] dark:bg-white/[0.10]',
                        )} />
                    ))}
                </div>
            </div>
            <ol className="hidden sm:flex items-start gap-2 overflow-x-auto" aria-label="Steps">
                {STEPS.map((s, i) => {
                    const done = i < current
                    const here = i === current
                    const summary = done ? summaries[s.id] : null
                    return (
                        <li key={s.id} className="flex items-start">
                            <div className="flex flex-col items-center">
                                <button
                                    type="button"
                                    onClick={() => done && onGoTo(s.id)}
                                    disabled={!done}
                                    aria-current={here ? 'step' : undefined}
                                    className={cn(
                                        'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-150',
                                        here
                                            ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-100 dark:ring-indigo-900'
                                            : done
                                                ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 cursor-pointer'
                                                : 'text-ink-muted cursor-not-allowed',
                                    )}
                                >
                                    {done ? <Check className="w-4 h-4" /> : (
                                        <span className={cn(
                                            'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                            here ? 'border-transparent bg-white/20' : 'border-black/[0.12] dark:border-white/[0.15]',
                                        )}>
                                            {i + 1}
                                        </span>
                                    )}
                                    {s.title}
                                </button>
                                {summary && (
                                    <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-medium mt-1 max-w-[130px] truncate">
                                        {summary}
                                    </span>
                                )}
                            </div>
                            {i < STEPS.length - 1 && (
                                <div className={cn(
                                    'w-6 lg:w-8 h-px mx-1.5 mt-4',
                                    done ? 'bg-indigo-400' : 'bg-black/[0.10] dark:bg-white/[0.12]',
                                )} />
                            )}
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}
