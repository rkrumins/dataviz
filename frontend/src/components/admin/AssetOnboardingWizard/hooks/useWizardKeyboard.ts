/**
 * useWizardKeyboard — Keyboard navigation hook for the onboarding wizard.
 *
 * - Escape → close wizard
 * - Cmd/Ctrl+Enter → proceed to next step (or submit on last step)
 * - Focus trapping within the modal container
 */
import { useEffect, useCallback, type RefObject } from 'react'

interface UseWizardKeyboardOptions {
    /** Ref to the modal container element for focus trapping */
    containerRef: RefObject<HTMLElement | null>
    /** Called when Escape is pressed */
    onClose: () => void
    /** Called when Cmd/Ctrl+Enter is pressed (not on last step) */
    onNext: () => void
    /** Called when Cmd/Ctrl+Enter is pressed on last step */
    onSubmit: () => void
    /** Whether the current step allows proceeding */
    canProceed: boolean
    /** Whether the current step is the last step */
    isLastStep: boolean
    /** Whether the wizard is currently submitting */
    isSubmitting: boolean
    /** Whether the wizard is in the success phase */
    isSuccess: boolean
    /** Whether the wizard is open */
    isOpen: boolean
}

export function useWizardKeyboard({
    containerRef,
    onClose,
    onNext,
    onSubmit,
    canProceed,
    isLastStep,
    isSubmitting,
    isSuccess,
    isOpen,
}: UseWizardKeyboardOptions) {
    // Focus trap: cycle Tab within the modal
    const handleFocusTrap = useCallback((e: KeyboardEvent) => {
        if (e.key !== 'Tab' || !containerRef.current) return

        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return

        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault()
                last.focus()
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault()
                first.focus()
            }
        }
    }, [containerRef])

    useEffect(() => {
        if (!isOpen) return

        const handler = (e: KeyboardEvent) => {
            // Escape → close
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
                return
            }

            // Cmd/Ctrl+Enter → next or submit
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                if (isSubmitting || isSuccess || !canProceed) return
                e.preventDefault()
                e.stopPropagation()
                if (isLastStep) {
                    onSubmit()
                } else {
                    onNext()
                }
                return
            }

            // Focus trap
            handleFocusTrap(e)
        }

        document.addEventListener('keydown', handler, true)
        return () => document.removeEventListener('keydown', handler, true)
    }, [isOpen, onClose, onNext, onSubmit, canProceed, isLastStep, isSubmitting, isSuccess, handleFocusTrap])

    // Auto-focus container when step changes
    useEffect(() => {
        if (!isOpen || !containerRef.current) return

        // Small delay to let AnimatePresence finish its transition
        const timer = setTimeout(() => {
            if (!containerRef.current) return
            const firstFocusable = containerRef.current.querySelector<HTMLElement>(
                'input:not([disabled]), select:not([disabled]), button:not([disabled])'
            )
            firstFocusable?.focus()
        }, 250)

        return () => clearTimeout(timer)
    }, [isOpen, containerRef])
}
