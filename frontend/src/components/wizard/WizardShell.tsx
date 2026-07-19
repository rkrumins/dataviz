/**
 * WizardShell — the premium wizard chrome, now shared.
 *
 * It lived as a module-PRIVATE function inside ViewWizard.tsx, and
 * AssetOnboardingWizard hand-copied it. That is precisely why Create Workspace was
 * built on the older AdminWizard: the good shell existed but nothing could import
 * it. Two copies, and the third consumer got the cheap one.
 *
 * Extracted as-is, with the two view-specific bits lifted into props: the
 * hard-coded "Create New View" heading (now `title` / `submitLabel`) and the
 * `currentStep === 'scope' || 'assignment'` width check (now `wide`).
 *
 * What it does that AdminWizard did not:
 *   • Next is DISABLED until the step is valid (`canProceed`) — AdminWizard let you
 *     click Next and then showed a red box telling you why it didn't work.
 *   • Completed pills are clickable to go back, and show a check.
 *   • A terminal phase INSIDE the shell ("creating" → "success"), so creating is the
 *     last step of the wizard rather than a detached dialog that appears after it.
 *   • Framer-motion step transitions instead of an instant content swap.
 */
import { useEffect, useId, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Loader2, X, ArrowLeft, ArrowRight, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { DocsLink } from '@/components/help/DocsLink'

export interface WizardStepDef {
    id: string
    label: string
    icon: React.ReactNode
}

export interface WizardShellProps {
    /** "Create New View", "Create Workspace" — the chrome no longer assumes views. */
    title: string
    /** The primary button on the final step. */
    submitLabel: string
    currentStep: string
    activeSteps: WizardStepDef[]
    currentStepIndex: number
    onStepClick: (stepId: string) => void
    onBack: () => void
    onNext: () => void
    onClose: () => void
    canProceed: boolean
    isLastStep: boolean
    isSubmitting: boolean
    onSubmit: () => void
    /** Create mode only: the wizard is past the form and is creating / has created
     *  the view. The chrome adapts — every step pill reads complete, a terminal pill
     *  is appended, and the footer is replaced by `footer`. Creating a view is the
     *  LAST STEP of the wizard, not a detached dialog. */
    terminalPhase?: 'creating' | 'success'
    terminalLabel?: string
    terminalSubtitle?: string
    /** Replaces the entire default footer (Back / Cancel / Next). */
    footer?: React.ReactNode
    /** Hide the header close button (nothing should abandon a create in flight). */
    hideClose?: boolean
    /** Some steps need the room (a picker grid, an assignment tree). */
    wide?: boolean
    /** When set, renders a contextual Guide link in the shell header. */
    helpSlug?: string
    children: React.ReactNode
}

export function WizardShell({
    title,
    submitLabel,
    currentStep,
    activeSteps,
    currentStepIndex,
    onStepClick,
    onBack,
    onNext,
    onClose,
    canProceed,
    isLastStep,
    isSubmitting,
    onSubmit,
    terminalPhase,
    terminalLabel = 'Create',
    terminalSubtitle,
    footer,
    hideClose,
    wide,
    helpSlug,
    children,
}: WizardShellProps) {
    const isTerminal = !!terminalPhase
    const isWide = !isTerminal && !!wide
    const titleId = useId()
    const dialogRef = useRef<HTMLDivElement>(null)

    // Move focus into the dialog on mount so keyboard + screen-reader users
    // land inside the wizard rather than back on the page behind the backdrop.
    useEffect(() => {
        dialogRef.current?.focus()
    }, [])

    return (
        <>
            <Backdrop open={true} zClassName="z-50" className="bg-black/60" />
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ duration: 0.12 }}
                className={cn(
                    'pointer-events-auto relative w-full max-h-[90vh] bg-canvas-elevated rounded-2xl shadow-lg overflow-hidden flex flex-col focus:outline-none',
                    isWide ? 'max-w-[1180px]' : 'max-w-5xl',
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-8 py-5 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02]">
                    <div className="flex items-center gap-4">
                        <div className={cn(
                            'w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-md',
                            terminalPhase === 'success'
                                ? 'bg-gradient-to-br from-emerald-500 to-teal-600'
                                : 'bg-gradient-to-br from-indigo-500 to-violet-600',
                        )}>
                            {terminalPhase === 'success'
                                ? <Check className="w-6 h-6" />
                                : terminalPhase === 'creating'
                                    ? <Loader2 className="w-6 h-6 animate-spin" />
                                    : activeSteps[currentStepIndex]?.icon}
                        </div>
                        <div>
                            <h2 id={titleId} className="text-xl font-bold text-ink">
                                {title}
                            </h2>
                            <p className="text-sm text-ink-muted">
                                {isTerminal
                                    ? terminalSubtitle
                                    : `Step ${currentStepIndex + 1} of ${activeSteps.length}: ${activeSteps[currentStepIndex]?.label}`}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {helpSlug && <DocsLink slug={helpSlug} variant="icon" />}
                        {!hideClose && (
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5 text-ink-muted" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Progress Steps — overflow-proof: connectors flex instead of fixed
                    widths, pills can shrink with truncating labels, and non-active
                    labels drop out below lg so all six steps always fit the modal.
                    In the terminal phase every step reads complete and a final pill
                    shows the create itself. */}
                <div className="px-8 py-4 bg-black/[0.02] dark:bg-white/[0.02] border-b border-glass-border">
                    <div className="flex items-center min-w-0">
                        {activeSteps.map((step, index) => {
                            const isActive = !isTerminal && step.id === currentStep
                            const isCompleted = isTerminal || currentStepIndex > index
                            const isClickable = !isTerminal && (isCompleted || isActive)
                            const showConnector = index < activeSteps.length - 1 || isTerminal
                            return (
                                <div key={step.id} className={cn('flex items-center min-w-0', showConnector && 'flex-1')}>
                                    <button
                                        onClick={() => isClickable && onStepClick(step.id)}
                                        disabled={!isClickable}
                                        title={step.label}
                                        aria-current={isActive ? 'step' : undefined}
                                        className={cn(
                                            'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-150 min-w-0 shrink',
                                            isActive
                                                ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-100 dark:ring-indigo-900'
                                                : isCompleted
                                                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100'
                                                    : 'text-ink-muted cursor-not-allowed',
                                        )}
                                    >
                                        {isCompleted
                                            ? <Check className="w-4 h-4" />
                                            : (
                                                <span className={cn(
                                                    'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                                    isActive ? 'border-transparent bg-white/20' : 'border-glass-border',
                                                )}>
                                                    {index + 1}
                                                </span>
                                            )}
                                        <span className={cn('truncate', !isActive && 'hidden lg:inline')}>
                                            {step.label}
                                        </span>
                                    </button>
                                    {showConnector && (
                                        <div className={cn(
                                            'flex-1 min-w-2 h-px mx-2',
                                            isCompleted ? 'bg-emerald-300 dark:bg-emerald-700' : 'bg-glass-border',
                                        )} />
                                    )}
                                </div>
                            )
                        })}

                        {isTerminal && (
                            <button
                                type="button"
                                disabled
                                className={cn(
                                    'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium min-w-0 shrink',
                                    terminalPhase === 'success'
                                        ? 'bg-emerald-500 text-white shadow-md'
                                        : 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-100 dark:ring-indigo-900',
                                )}
                            >
                                {terminalPhase === 'success'
                                    ? <Check className="w-4 h-4" />
                                    : <Loader2 className="w-4 h-4 animate-spin" />}
                                <span className="truncate">{terminalLabel}</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Step Content */}
                <div className="flex-1 overflow-y-auto min-h-[520px]">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={terminalPhase ?? currentStep}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.06 }}
                            className="p-8"
                        >
                            {children}
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-8 py-5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                    {footer ?? (
                        <>
                            <button
                                onClick={onBack}
                                disabled={currentStepIndex === 0}
                                className={cn(
                                    'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    currentStepIndex > 0
                                        ? 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5'
                                        : 'text-ink-muted cursor-not-allowed',
                                )}
                            >
                                <ArrowLeft className="w-4 h-4" />
                                Back
                            </button>

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={onClose}
                                    className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                                >
                                    Cancel
                                </button>

                                {isLastStep ? (
                                    <button
                                        onClick={onSubmit}
                                        disabled={!canProceed || isSubmitting}
                                        className={cn(
                                            'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                            canProceed && !isSubmitting
                                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                                : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                        )}
                                    >
                                        {isSubmitting ? (
                                            <><Loader2 className="w-4 h-4 animate-spin" />Saving...</>
                                        ) : (
                                            <><Save className="w-4 h-4" />{submitLabel}</>
                                        )}
                                    </button>
                                ) : (
                                    <button
                                        onClick={onNext}
                                        disabled={!canProceed}
                                        className={cn(
                                            'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                            canProceed
                                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                                : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                                        )}
                                    >
                                        Next
                                        <ArrowRight className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </motion.div>
            </div>
        </>
    )
}
