/**
 * AdminWizard — generic multi-step wizard shell.
 * Inspired by ViewWizard patterns with animated transitions.
 */
import { useState, useCallback, type ReactNode } from 'react'
import { X, ChevronLeft, ChevronRight, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface WizardStep {
    id: string
    title: string
    description?: string
    icon?: React.ComponentType<{ className?: string }>
    validate?: () => boolean | string  // returns true or error message
    content: ReactNode
}

interface AdminWizardProps {
    title: string
    steps: WizardStep[]
    isOpen: boolean
    onClose: () => void
    onComplete: () => void | Promise<void>
    isSubmitting?: boolean
    completionLabel?: string
}

export function AdminWizard({
    title,
    steps,
    isOpen,
    onClose,
    onComplete,
    isSubmitting = false,
    completionLabel = 'Create',
}: AdminWizardProps) {
    const [currentStep, setCurrentStep] = useState(0)
    const [validationError, setValidationError] = useState<string | null>(null)

    const goNext = useCallback(() => {
        const step = steps[currentStep]
        if (step.validate) {
            const result = step.validate()
            if (result !== true) {
                setValidationError(typeof result === 'string' ? result : 'Please complete this step.')
                return
            }
        }
        setValidationError(null)
        if (currentStep < steps.length - 1) {
            setCurrentStep(c => c + 1)
        }
    }, [currentStep, steps])

    const goBack = useCallback(() => {
        setValidationError(null)
        if (currentStep > 0) setCurrentStep(c => c - 1)
    }, [currentStep])

    const handleComplete = async () => {
        const step = steps[currentStep]
        if (step.validate) {
            const result = step.validate()
            if (result !== true) {
                setValidationError(typeof result === 'string' ? result : 'Please complete this step.')
                return
            }
        }
        setValidationError(null)
        await onComplete()
        setCurrentStep(0)
    }

    if (!isOpen) return null

    const isLast = currentStep === steps.length - 1
    const activeStep = steps[currentStep]

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 animate-in fade-in duration-200">
            <div className="bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 animate-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border shrink-0">
                    <div>
                        <h2 className="text-lg font-bold text-ink">{title}</h2>
                        <p className="text-sm text-ink-muted mt-0.5">{activeStep.title}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted hover:text-ink transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Step Progress */}
                <div className="px-6 py-3 border-b border-glass-border flex items-center gap-2 shrink-0">
                    {steps.map((step, i) => {
                        const StepIcon = step.icon
                        const isComplete = i < currentStep
                        const isCurrent = i === currentStep
                        return (
                            <div key={step.id} className="flex items-center gap-2">
                                {i > 0 && <div className={cn("w-8 h-0.5 rounded-full", isComplete ? "bg-indigo-500" : "bg-glass-border")} />}
                                <div className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                                    isComplete ? "bg-indigo-500/10 text-indigo-500" :
                                        isCurrent ? "bg-indigo-500 text-white shadow-md shadow-indigo-500/25" :
                                            "bg-black/5 dark:bg-white/5 text-ink-muted"
                                )}>
                                    {isComplete ? <Check className="w-3 h-3" /> :
                                        StepIcon ? <StepIcon className="w-3 h-3" /> :
                                            <span>{i + 1}</span>}
                                    <span className="hidden sm:inline">{step.title}</span>
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-6 py-5">
                    {activeStep.content}
                    {validationError && (
                        <div className="mt-4 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-500">
                            {validationError}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-glass-border shrink-0">
                    <button
                        onClick={currentStep === 0 ? onClose : goBack}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        {currentStep === 0 ? 'Cancel' : 'Back'}
                    </button>

                    <button
                        onClick={isLast ? handleComplete : goNext}
                        disabled={isSubmitting}
                        className={cn(
                            "flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all",
                            isLast
                                ? "bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/30 disabled:opacity-50"
                                : "bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20"
                        )}
                    >
                        {isSubmitting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : isLast ? (
                            <>
                                <Check className="w-4 h-4" />
                                {completionLabel}
                            </>
                        ) : (
                            <>
                                Next
                                <ChevronRight className="w-4 h-4" />
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    )
}
