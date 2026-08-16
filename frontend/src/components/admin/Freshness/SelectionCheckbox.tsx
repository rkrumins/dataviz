/**
 * SelectionCheckbox — list-row selection control matching Workspaces /
 * Explorer: always-drawn rounded square, indigo fill when checked, clear
 * hover + focus. A button with role="checkbox", not a native input.
 */
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SelectionCheckbox({
    selected, indeterminate = false, onToggle, ariaLabel, className,
}: {
    selected: boolean
    indeterminate?: boolean
    onToggle: () => void
    ariaLabel: string
    className?: string
}) {
    const checked = selected || indeterminate
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={indeterminate ? 'mixed' : selected}
            aria-label={ariaLabel}
            title={ariaLabel}
            onClick={(e) => {
                e.stopPropagation()
                onToggle()
            }}
            className={cn('group/check inline-flex shrink-0 outline-none', className)}
        >
            <span
                className={cn(
                    'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border-2 transition-all duration-150',
                    'group-focus-visible/check:ring-2 group-focus-visible/check:ring-indigo-500/40 group-focus-visible/check:ring-offset-1 group-focus-visible/check:ring-offset-canvas',
                    checked
                        ? 'border-indigo-500 bg-indigo-500 text-white shadow-sm shadow-indigo-500/25'
                        : 'border-ink-muted/35 bg-canvas/60 text-transparent group-hover/check:border-indigo-500 group-hover/check:bg-indigo-500/10',
                )}
            >
                {indeterminate ? (
                    <Minus className="h-3 w-3 text-white" strokeWidth={3} />
                ) : (
                    <Check
                        className={cn('h-3 w-3 transition-opacity', selected ? 'opacity-100' : 'opacity-0')}
                        strokeWidth={3}
                    />
                )}
            </span>
        </button>
    )
}
