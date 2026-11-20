/**
 * What a control inside a <Field> needs to be wired to it: its id (the label's `for`), the ids of
 * the help and error text that describe it, and whether it is invalid, required or disabled.
 *
 * Every input in `components/ui` reads this, so a caller writes `<Field label help error><Input/>`
 * and gets the ARIA right without passing ids by hand. Outside a Field the context is null and a
 * control uses only what it is given.
 */
import { createContext, useContext } from 'react'

export interface FieldState {
    controlId: string
    labelId: string
    helpId?: string
    errorId?: string
    invalid: boolean
    required: boolean
    disabled: boolean
}

export const FieldContext = createContext<FieldState | null>(null)

export function useField(): FieldState | null {
    return useContext(FieldContext)
}

/** The props a control spreads onto its focusable element: the Field's wiring, then the caller's. */
export function fieldControlProps(field: FieldState | null, own: {
    id?: string
    'aria-describedby'?: string
    'aria-invalid'?: boolean
    disabled?: boolean
    required?: boolean
} = {}) {
    const describedBy = [own['aria-describedby'], field?.helpId, field?.invalid ? field.errorId : undefined]
        .filter(Boolean).join(' ') || undefined
    const invalid = own['aria-invalid'] ?? field?.invalid ?? false
    return {
        id: own.id ?? field?.controlId,
        'aria-describedby': describedBy,
        'aria-invalid': invalid || undefined,
        'aria-errormessage': invalid && field?.errorId ? field.errorId : undefined,
        'aria-required': (own.required ?? field?.required) || undefined,
        disabled: own.disabled ?? field?.disabled ?? false,
    }
}
