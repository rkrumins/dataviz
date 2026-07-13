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
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Loader2, X, ArrowLeft, ArrowRight, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'

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
    children,
}: WizardShellProps) {
    const isTerminal = !!terminalPhase
    const isWide = !isTerminal && !!wide

    return (
        <>
            <Backdrop open={true} zClassName="z-50" className="bg-black/60" />
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ duration: 0.12 }}
                className={cn(
                    'pointer-events-auto relative w-full max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-lg overflow-hidden flex flex-col',
                    isWide ? 'max-w-[1180px]' : 'max-w-5xl',
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900">
                    <div className="flex items-center gap-4">
                        <div className={cn(
                            'w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-md',
                            terminalPhase === 'success'
                                ? 'bg-gradient-to-br from-emerald-500 to-teal-600'
                                : 'bg-gradient-to-br from-blue-500 to-indigo-600',
                        )}>
                            {terminalPhase === 'success'
                                ? <Check className="w-6 h-6" />
                                : terminalPhase === 'creating'
                                    ? <Loader2 className="w-6 h-6 animate-spin" />
                                    : activeSteps[currentStepIndex]?.icon}
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                                {title}
                            </h2>
                            <p className="text-sm text-slate-500">
                                {isTerminal
                                    ? terminalSubtitle
                                    : `Step ${currentStepIndex + 1} of ${activeSteps.length}: ${activeSteps[currentStepIndex]?.label}`}
                            </p>
                        </div>
                    </div>
                    {!hideClose && (
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            <X className="w-5 h-5 text-slate-500" />
                        </button>
                    )}
                </div>

                {/* Progress Steps — overflow-proof: connectors flex instead of fixed
                    widths, pills can shrink with truncating labels, and non-active
                    labels drop out below lg so all six steps always fit the modal.
                    In the terminal phase every step reads complete and a final pill
                    shows the create itself. */}
                <div className="px-8 py-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
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
                                        className={cn(
                                            'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-150 min-w-0 shrink',
                                            isActive
                                                ? 'bg-blue-600 text-white shadow-md ring-2 ring-blue-100 dark:ring-blue-900'
                                                : isCompleted
                                                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100'
                                                    : 'text-slate-400 cursor-not-allowed',
                                        )}
                                    >
                                        {isCompleted
                                            ? <Check className="w-4 h-4" />
                                            : (
                                                <span className={cn(
                                                    'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                                    isActive ? 'border-transparent bg-white/20' : 'border-slate-300',
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
                                            isCompleted ? 'bg-emerald-300 dark:bg-emerald-700' : 'bg-slate-200 dark:bg-slate-700',
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
                                        : 'bg-blue-600 text-white shadow-md ring-2 ring-blue-100 dark:ring-blue-900',
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
                <div className="flex items-center justify-between px-8 py-5 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    {footer ?? (
                        <>
                            <button
                                onClick={onBack}
                                disabled={currentStepIndex === 0}
                                className={cn(
                                    'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    currentStepIndex > 0
                                        ? 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                        : 'text-slate-400 cursor-not-allowed',
                                )}
                            >
                                <ArrowLeft className="w-4 h-4" />
                                Back
                            </button>

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={onClose}
                                    className="px-5 py-2.5 rounded-xl font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors duration-150"
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
                                                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md'
                                                : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed',
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
                                                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md'
                                                : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed',
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
