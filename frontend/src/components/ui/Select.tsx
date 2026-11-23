/**
 * Select — pick one of a list, with the app's edge and focus ring.
 *
 * A native <select> underneath, on purpose: it is the most accessible list picker there is, it
 * opens the phone's own wheel on mobile, and the dark theme's `color-scheme` gives its menu the
 * right colours. Inside a <Field> it takes the field's id and ARIA.
 */
import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CONTROL_DISABLED, CONTROL_INVALID, CONTROL_SHELL, CONTROL_SIZE } from './controlStyles'
import { fieldControlProps, useField } from './fieldContext'

export interface SelectOption<T extends string = string> {
    value: T
    label: string
    disabled?: boolean
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'size'> {
    value: T
    onChange: (value: T) => void
    options: readonly SelectOption<T>[]
    size?: 'sm' | 'md'
    invalid?: boolean
    containerClassName?: string
}

export function Select<T extends string>({
    value, onChange, options, size = 'md', invalid, disabled, required, id, className, containerClassName, ...rest
}: SelectProps<T>) {
    const wiring = fieldControlProps(useField(), {
        id, disabled, required, 'aria-describedby': rest['aria-describedby'], 'aria-invalid': invalid,
    })
    return (
        <div className={cn(CONTROL_SHELL, CONTROL_SIZE[size], 'relative',
            wiring['aria-invalid'] && CONTROL_INVALID, wiring.disabled && CONTROL_DISABLED, containerClassName)}>
            <select
                {...rest}
                {...wiring}
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
                className={cn('h-full w-full min-w-0 appearance-none bg-transparent pl-3 pr-8 outline-none cursor-pointer',
                    'disabled:cursor-not-allowed', className)}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
                ))}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 w-4 h-4 text-ink-muted" />
        </div>
    )
}
