/**
 * ConfirmDialog — the house dialog shell (a portal, a sibling <Backdrop>, a
 * focus-trapped panel) around a confirmation: what will happen, then Cancel
 * or the action. Used by Adopt and by saving the residency policy, whose
 * confirmations say what the change does before anything changes.
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/primitives'

interface Props {
    title: string
    confirmLabel: string
    onConfirm: () => void
    onClose: () => void
    pending?: boolean
    error?: string | null
    children: ReactNode
}

export function ConfirmDialog({ title, confirmLabel, onConfirm, onClose, pending = false, error, children }: Props) {
    const dialogRef = useModalA11y(true, onClose)
    return createPortal(
        <>
            <Backdrop open onClick={pending ? undefined : onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                <div
                    ref={dialogRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-dialog-title"
                    className="pointer-events-auto outline-none w-full max-w-lg rounded-xl border border-glass-border bg-canvas-elevated shadow-lg"
                >
                    <h2 id="confirm-dialog-title" className="px-5 pt-4 pb-2 text-sm font-semibold text-ink">{title}</h2>
                    <div className="px-5 pb-4 space-y-2 text-xs text-ink-secondary">
                        {children}
                        {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
                    </div>
                    <div className="px-5 py-3 border-t border-glass-border flex justify-end gap-2">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
                        <Button size="sm" variant="primary" loading={pending} onClick={onConfirm}>{confirmLabel}</Button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
