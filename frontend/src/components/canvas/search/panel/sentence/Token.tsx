/**
 * Token — one clickable part of a sentence: a type, a verb, a value, a
 * gap still to fill. Clicking it opens a popover holding the editor for
 * exactly that part; Esc (or a click away) closes it and puts focus back
 * on the token.
 *
 * The popover is portaled (Radix) so it never sits inside the panel's
 * blurred, clipped column. Pickers inside it portal their own menus; those
 * are marked ``data-floating-layer`` so a pick in one isn't taken for a
 * click outside the popover.
 */
import * as Popover from '@radix-ui/react-popover'
import { type ReactNode, forwardRef } from 'react'

import { cn } from '@/lib/utils'


export type TokenTone =
    /** A type the query finds or a relative is: the type's own colour. */
    | 'entity'
    /** A relationship's verb: the accent. */
    | 'verb'
    /** Something picked: a name, a tag, a number. */
    | 'value'
    /** Words that are the choice ("has no downstream lineage"). */
    | 'phrase'
    /** Not picked yet. */
    | 'gap'

const TONE: Record<TokenTone, string> = {
    entity: 'font-medium border-transparent',
    verb: 'font-medium text-accent-lineage bg-accent-lineage/10 border-accent-lineage/20 hover:bg-accent-lineage/15',
    value: 'text-ink bg-black/[0.04] dark:bg-white/[0.06] border-glass-border hover:border-accent-lineage/40',
    phrase: 'text-ink border-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.06] underline decoration-dotted decoration-ink-muted/50 underline-offset-4',
    gap: 'text-ink-muted border-dashed border-ink-muted/50 hover:border-accent-lineage/60 hover:text-accent-lineage',
}


interface TokenPillProps {
    tone: TokenTone
    /** Inline colour for an ``entity`` token: the type's own. */
    color?: string
    icon?: ReactNode
    children: ReactNode
    ariaLabel: string
    className?: string
}

/** The pill alone (a Popover trigger wraps it). */
export const TokenPill = forwardRef<HTMLButtonElement, TokenPillProps & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>>(
    function TokenPill({ tone, color, icon, children, ariaLabel, className, ...rest }, ref) {
        return (
            <button
                ref={ref}
                type="button"
                aria-label={ariaLabel}
                aria-haspopup="dialog"
                className={cn(
                    'inline-flex items-center gap-1 max-w-full rounded-lg border px-1.5 py-0.5',
                    'text-sm leading-6 align-baseline transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    'data-[state=open]:ring-2 data-[state=open]:ring-accent-lineage/40',
                    TONE[tone],
                    className,
                )}
                style={tone === 'entity' && color
                    ? { color, backgroundColor: `${color}1a`, borderColor: `${color}33` }
                    : undefined}
                {...rest}
            >
                {icon}
                <span className="truncate">{children}</span>
            </button>
        )
    },
)


export interface TokenProps extends TokenPillProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The editor the token opens. */
    editor: ReactNode
    /** The editor's heading: what the part is ("Which types"). */
    title: string
    width?: 'sm' | 'md' | 'lg'
}

const WIDTH = { sm: 'w-[min(18rem,calc(100vw-1.5rem))]', md: 'w-[min(24rem,calc(100vw-1.5rem))]',
    lg: 'w-[min(30rem,calc(100vw-1.5rem))]' }

/** A pick in a picker's own portaled menu is not a click outside. */
function insideFloatingLayer(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('[data-floating-layer]')
}


export function Token({ open, onOpenChange, editor, title, width = 'md', ...pill }: TokenProps) {
    return (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
            <Popover.Trigger asChild>
                <TokenPill {...pill} />
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                    aria-label={title}
                    onInteractOutside={(e) => { if (insideFloatingLayer(e.target)) e.preventDefault() }}
                    onFocusOutside={(e) => { if (insideFloatingLayer(e.target)) e.preventDefault() }}
                    // Keys typed in an editor are the editor's: the panel's
                    // own shortcuts (J/K, E) must not fire underneath.
                    onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
                    className={cn(
                        WIDTH[width],
                        'z-50 rounded-xl border border-glass-border bg-canvas-elevated p-3',
                        'shadow-2xl shadow-black/25 flex flex-col gap-2.5',
                        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
                    )}
                >
                    <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{title}</div>
                    {editor}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
