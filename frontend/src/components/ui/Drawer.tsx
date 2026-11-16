/**
 * Drawer — a side sheet for working on one thing (a graph's settings) without leaving the page.
 *
 * A Radix modal dialog shaped as a sheet: focus moves in and is trapped, Esc closes, the page
 * behind is inert, and focus returns to what opened it. Full width on a phone; a fixed reading
 * width from `sm` up. The header and footer stay put and the body scrolls between them.
 *
 * Like Dialog: drive it with `open` and keep it mounted, and it slides in without an exit
 * animation. Reduced motion drops the slide (`globals.css` quiets `animate-in`).
 */
import type { ReactNode } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from './Button'
import { useReturnFocus } from './returnFocus'

const WIDTH = { md: 'sm:max-w-md', lg: 'sm:max-w-xl', xl: 'sm:max-w-3xl' } as const

export interface DrawerProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    /** Above the title: a short eyebrow (the scope, the kind of thing). */
    eyebrow?: ReactNode
    /** Beside the close button. */
    actions?: ReactNode
    children: ReactNode
    footer?: ReactNode
    side?: 'right' | 'left'
    size?: keyof typeof WIDTH
    dismissible?: boolean
    className?: string
}

export function Drawer({
    open, onOpenChange, title, description, eyebrow, actions, children, footer, side = 'right', size = 'lg',
    dismissible = true, className,
}: DrawerProps) {
    const hold = (e: Event) => { if (!dismissible) e.preventDefault() }
    const focus = useReturnFocus()
    return (
        <RadixDialog.Root open={open} onOpenChange={(next) => { if (next || dismissible) onOpenChange(next) }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[60] bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-200" />
                <RadixDialog.Content
                    {...(description ? {} : { 'aria-describedby': undefined })}
                    onOpenAutoFocus={focus.onOpenAutoFocus}
                    onCloseAutoFocus={focus.onCloseAutoFocus}
                    onEscapeKeyDown={hold}
                    onPointerDownOutside={hold}
                    onInteractOutside={hold}
                    className={cn(
                        'fixed inset-y-0 z-[60] flex h-full w-full flex-col bg-canvas-elevated text-ink outline-none',
                        'shadow-[0_0_0_1px_rgba(15,23,42,0.06),0_24px_64px_-12px_rgba(15,23,42,0.35)]',
                        'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_24px_64px_-12px_rgba(0,0,0,0.9)]',
                        'data-[state=open]:animate-in duration-200 ease-out',
                        side === 'right'
                            ? 'right-0 sm:border-l border-glass-border/60 data-[state=open]:slide-in-from-right-8'
                            : 'left-0 sm:border-r border-glass-border/60 data-[state=open]:slide-in-from-left-8',
                        'data-[state=open]:fade-in-0',
                        WIDTH[size],
                        className,
                    )}
                >
                    <div className="flex items-start gap-3 border-b border-glass-border/60 px-5 sm:px-6 pt-5 pb-4">
                        <div className="min-w-0 flex-1">
                            {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{eyebrow}</p>}
                            <RadixDialog.Title className={cn('text-base font-semibold tracking-tight text-ink', eyebrow && 'mt-0.5')}>
                                {title}
                            </RadixDialog.Title>
                            {description && (
                                <RadixDialog.Description className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                                    {description}
                                </RadixDialog.Description>
                            )}
                        </div>
                        {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
                        <RadixDialog.Close asChild>
                            <IconButton icon={X} label="Close" tip={false} disabled={!dismissible} className="-mr-2 shrink-0" />
                        </RadixDialog.Close>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6 py-5">{children}</div>
                    {footer && (
                        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border/60 px-5 sm:px-6 py-4">
                            {footer}
                        </div>
                    )}
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    )
}
