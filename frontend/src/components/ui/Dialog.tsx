/**
 * Dialog and ConfirmDialog — a modal for a decision, on Radix Dialog.
 *
 * Radix owns the behaviour a modal owes a keyboard and a screen reader: focus moves in and stays in
 * (Tab wraps), Esc closes, the page behind is inert and does not scroll, focus goes back to what
 * opened it, and the title and description name and describe it.
 *
 * Drive it with `open`; keep it mounted. A Radix modal that unmounts while open can leave the body
 * unclickable (`radixPointerEventsGuard` heals that app-wide, but a closed dialog never needs it).
 * It animates in and not out, for the same reason: an exit animation on a portaled layer is how a
 * click-blocker gets stranded.
 *
 * `dismissible={false}` holds it open while something is in flight: Esc, the backdrop and the close
 * button do nothing until it is done.
 */
import { useState, type ReactNode, type RefObject } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, IconButton } from './Button'
import { useReturnFocus } from './returnFocus'

const WIDTH = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const

export interface DialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    /** Before the title: an icon in its tile. */
    icon?: ReactNode
    children?: ReactNode
    /** The actions, at the bottom, always in view. */
    footer?: ReactNode
    size?: keyof typeof WIDTH
    dismissible?: boolean
    /** Where focus goes on opening; the first control by default. */
    initialFocus?: RefObject<HTMLElement | null>
    className?: string
}

export function Dialog({
    open, onOpenChange, title, description, icon, children, footer, size = 'md', dismissible = true, initialFocus, className,
}: DialogProps) {
    const hold = (e: Event) => { if (!dismissible) e.preventDefault() }
    const focus = useReturnFocus(initialFocus)
    return (
        <RadixDialog.Root open={open} onOpenChange={(next) => { if (next || dismissible) onOpenChange(next) }}>
            <RadixDialog.Portal>
                {/* The overlay centres the panel and scrolls when it is taller than the window, so the
                    panel needs no transform of its own and its zoom-in can't fight a translate. */}
                <RadixDialog.Overlay
                    className={cn(
                        'fixed inset-0 z-[60] grid place-items-center overflow-y-auto p-3 sm:p-6',
                        'bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150',
                    )}
                >
                    <RadixDialog.Content
                        {...(description ? {} : { 'aria-describedby': undefined })}
                        onOpenAutoFocus={focus.onOpenAutoFocus}
                        onCloseAutoFocus={focus.onCloseAutoFocus}
                        onEscapeKeyDown={hold}
                        onPointerDownOutside={hold}
                        onInteractOutside={hold}
                        className={cn(
                            'relative flex w-full flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)]',
                            'rounded-2xl border border-glass-border/60 bg-canvas-elevated text-ink outline-none',
                            'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_24px_64px_-24px_rgba(15,23,42,0.45)]',
                            'dark:shadow-[0_1px_2px_rgba(0,0,0,0.6),0_24px_64px_-20px_rgba(0,0,0,0.9)]',
                            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] duration-150',
                            WIDTH[size],
                            className,
                        )}
                    >
                        <div className="flex items-start gap-3.5 px-6 pt-5 pb-4">
                            {icon && <span className="shrink-0">{icon}</span>}
                            <div className="min-w-0 flex-1">
                                <RadixDialog.Title className="text-base font-semibold tracking-tight text-ink">{title}</RadixDialog.Title>
                                {description && (
                                    <RadixDialog.Description className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                                        {description}
                                    </RadixDialog.Description>
                                )}
                            </div>
                            <RadixDialog.Close asChild>
                                <IconButton icon={X} label="Close" tip={false} disabled={!dismissible} className="-mr-2 -mt-1" />
                            </RadixDialog.Close>
                        </div>
                        {children != null && <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>}
                        {footer && (
                            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border/60 px-6 py-4">
                                {footer}
                            </div>
                        )}
                    </RadixDialog.Content>
                </RadixDialog.Overlay>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    )
}

export interface ConfirmDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    /** What happens, in a sentence or a short list. */
    children?: ReactNode
    confirmLabel: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
    /** May return a promise: the dialog shows it running and holds open until it settles. */
    onConfirm: () => void | Promise<void>
    /** Busy from outside; otherwise busy while `onConfirm`'s promise runs. */
    pending?: boolean
    confirmDisabled?: boolean
    error?: ReactNode
}

/** A question with two answers: Cancel, or the action named on its button. */
export function ConfirmDialog({
    open, onOpenChange, title, description, children, confirmLabel, cancelLabel = 'Cancel', tone = 'default',
    onConfirm, pending, confirmDisabled, error,
}: ConfirmDialogProps) {
    const [running, setRunning] = useState(false)
    const busy = pending ?? running
    const confirm = async () => {
        setRunning(true)
        try {
            await onConfirm()
        } finally {
            setRunning(false)
        }
    }
    return (
        <Dialog
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            description={description}
            size="sm"
            dismissible={!busy}
            footer={(
                <>
                    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
                    <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={confirmDisabled}
                        onClick={() => { void confirm() }}>
                        {confirmLabel}
                    </Button>
                </>
            )}
        >
            {(children || error) && (
                <div className="space-y-3 text-[13px] leading-relaxed text-ink-secondary">
                    {children}
                    {error && <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
                </div>
            )}
        </Dialog>
    )
}
