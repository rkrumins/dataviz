/**
 * Input — a text box with the app's edge, focus ring and invalid state, and room for what sits
 * inside it: an icon before, a unit after ("ms", "%"). The unit is part of the field, so a number
 * is never shown without one. Inside a <Field> it takes the field's id and ARIA.
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CONTROL_DISABLED, CONTROL_INVALID, CONTROL_SHELL, CONTROL_SIZE } from './controlStyles'
import { fieldControlProps, useField } from './fieldContext'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
    size?: 'sm' | 'md'
    invalid?: boolean
    leading?: ReactNode
    /** Shown after the text: a unit, a hint. */
    trailing?: ReactNode
    containerClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
    { size = 'md', invalid, leading, trailing, className, containerClassName, id, disabled, required, type = 'text', ...rest },
    ref,
) {
    const wiring = fieldControlProps(useField(), {
        id, disabled, required, 'aria-describedby': rest['aria-describedby'], 'aria-invalid': invalid,
    })
    return (
        <div className={cn(CONTROL_SHELL, CONTROL_SIZE[size], wiring['aria-invalid'] && CONTROL_INVALID,
            wiring.disabled && CONTROL_DISABLED, containerClassName)}>
            {leading && <span className="pl-3 flex items-center text-ink-muted shrink-0">{leading}</span>}
            <input
                ref={ref}
                type={type}
                {...rest}
                {...wiring}
                className={cn(
                    'h-full min-w-0 flex-1 bg-transparent px-3 outline-none placeholder:text-ink-muted',
                    'disabled:cursor-not-allowed',
                    leading && 'pl-2',
                    trailing && 'pr-1.5',
                    className,
                )}
            />
            {trailing && <span className="pr-3 flex items-center text-ink-muted shrink-0 text-xs font-medium">{trailing}</span>}
        </div>
    )
})
