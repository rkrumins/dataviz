/**
 * Field — a control with its label, a one-line explanation, and the error that names what is wrong.
 *
 * It owns the wiring every form owes a screen reader and usually forgets: the label is the
 * control's accessible name, the help line and the error describe it, the error is announced when
 * it appears (a polite live region that is always present, so the first error is heard too), and
 * the control says it is invalid. Controls from `components/ui` pick this up from context.
 *
 * `group` is for a control that is a group of buttons (choice cards, a segmented control): there
 * is no single element to point `for` at, so the label names the group by `aria-labelledby`.
 *
 * `inline` lays the words on the left and the control on the right (a settings row); on a small
 * screen they stack.
 */
import { useId, useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { FieldContext, type FieldState } from './fieldContext'

export interface FieldProps {
    label: ReactNode
    /** One line that says what the control does. More belongs behind a disclosure, not here. */
    help?: ReactNode
    /** What is wrong with the value, in words that say how to fix it. */
    error?: ReactNode | null
    required?: boolean
    disabled?: boolean
    /** Beside the label: a badge or a link. */
    aside?: ReactNode
    layout?: 'stacked' | 'inline'
    group?: boolean
    /** The control's id, when the caller needs to know it. */
    id?: string
    className?: string
    children: ReactNode
}

export function Field({
    label, help, error, required = false, disabled = false, aside, layout = 'stacked', group = false, id, className, children,
}: FieldProps) {
    const auto = useId()
    const controlId = id ?? `${auto}-control`
    const invalid = error != null && error !== false && error !== ''
    const state = useMemo<FieldState>(() => ({
        controlId,
        labelId: `${auto}-label`,
        helpId: help ? `${auto}-help` : undefined,
        errorId: `${auto}-error`,
        invalid,
        required,
        disabled,
    }), [auto, controlId, help, invalid, required, disabled])

    const Label = group ? 'span' : 'label'
    const words = (
        <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Label
                    id={state.labelId}
                    {...(group ? {} : { htmlFor: controlId })}
                    className={cn('text-[13px] font-semibold text-ink', disabled && 'opacity-60')}
                >
                    {label}
                    {required && <span aria-hidden className="ml-0.5 text-rose-600 dark:text-rose-400">*</span>}
                </Label>
                {aside}
            </div>
            {help && <p id={state.helpId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">{help}</p>}
        </div>
    )
    const errorLine = (
        <p id={state.errorId} aria-live="polite" className={cn('text-xs font-medium text-rose-600 dark:text-rose-400', invalid ? 'mt-1.5' : 'sr-only')}>
            {invalid ? error : ''}
        </p>
    )

    return (
        <FieldContext.Provider value={state}>
            {layout === 'inline' ? (
                <div className={cn('grid gap-x-6 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:items-start', className)}>
                    {words}
                    <div className="min-w-0 md:justify-self-end">
                        {children}
                        {errorLine}
                    </div>
                </div>
            ) : (
                <div className={cn('grid gap-1.5', className)}>
                    {words}
                    <div className="min-w-0">
                        {children}
                        {errorLine}
                    </div>
                </div>
            )}
        </FieldContext.Provider>
    )
}
