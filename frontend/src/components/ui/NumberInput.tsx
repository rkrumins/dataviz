/**
 * NumberInput — a number you can type, step with − and +, or move with the keyboard.
 *
 * A spinbutton: ↑ and ↓ step (Shift for ten steps), Page Up and Page Down take ten steps. The
 * steppers and the keys stop at the bounds; typing is not clamped, so a value out of
 * range is shown and the caller's validation says what is allowed, rather than the field quietly
 * changing what was typed. Text that isn't a number is never sent: the field marks itself invalid
 * while it holds it, and puts the last good value back when it loses focus.
 *
 * Numbers show with separators ("200,000") and read back with them. The unit sits inside the field
 * and is spoken with the value ("85 %").
 */
import { useState, type KeyboardEvent } from 'react'
import { Minus, Plus } from 'lucide-react'
import { cn, clamp } from '@/lib/utils'
import { formatNumber, parseNumber } from '@/lib/units'
import { CONTROL_DISABLED, CONTROL_INVALID, CONTROL_SHELL, CONTROL_SIZE } from './controlStyles'
import { fieldControlProps, useField } from './fieldContext'

export interface NumberInputProps {
    value: number | null
    onChange: (value: number | null) => void
    min?: number
    max?: number
    step?: number
    /** Page Up / Page Down, and Shift with an arrow. Ten steps by default. */
    bigStep?: number
    /** Decimal places a value keeps. From `step` by default (a step of 0.05 keeps two). */
    decimals?: number
    /** Shown after the number, and spoken with it. */
    unit?: string
    /** What the − and + buttons change, for their names: "Decrease Start mark". */
    name?: string
    /** The value stepping starts from while there is none (an inherited value). */
    fallback?: number
    format?: (n: number) => string
    parse?: (text: string) => number | null
    /** The value as spoken, if not "the number and its unit". */
    valueText?: (n: number) => string
    /** Empty text means "no value" (null); otherwise empty text is put back on blur. */
    allowEmpty?: boolean
    placeholder?: string
    size?: 'sm' | 'md'
    invalid?: boolean
    disabled?: boolean
    steppers?: boolean
    id?: string
    className?: string
    inputClassName?: string
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
}

function decimalsOf(step: number): number {
    const s = String(step)
    return s.includes('.') ? s.split('.')[1].length : 0
}

function round(n: number, places: number): number {
    const f = 10 ** places
    return Math.round(n * f) / f
}

export function NumberInput({
    value, onChange, min, max, step = 1, bigStep, decimals, unit, name, fallback, format, parse, valueText,
    allowEmpty = false, placeholder, size = 'md', invalid, disabled, steppers = true, id, className, inputClassName,
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy,
}: NumberInputProps) {
    const places = decimals ?? decimalsOf(step)
    const show = format ?? ((n: number) => formatNumber(n, { maxFractionDigits: places }))
    const read = parse ?? ((t: string) => parseNumber(t))
    const [draft, setDraft] = useState<string | null>(null)
    const text = draft ?? (value == null ? '' : show(value))
    const unreadable = draft !== null && draft.trim() !== '' && read(draft) === null
    const wiring = fieldControlProps(useField(), {
        id, disabled, 'aria-describedby': ariaDescribedBy, 'aria-invalid': invalid || unreadable || undefined,
    })
    const off = wiring.disabled
    const lo = min ?? -Infinity
    const hi = max ?? Infinity

    const send = (n: number | null) => onChange(n === null ? null : round(n, places))

    const bump = (delta: number) => {
        const base = value ?? fallback ?? (min ?? 0)
        const next = round(clamp(base + delta, lo, hi), places)
        send(next)
        if (draft !== null) setDraft(show(next))
    }

    // Home and End stay the caret's: in a box of digits, moving the caret is worth more than a jump
    // to a bound (the sliders take Home and End).
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            setDraft(null)
            return
        }
        const big = bigStep ?? step * 10
        const delta: Record<string, number> = {
            ArrowUp: e.shiftKey ? big : step,
            ArrowDown: -(e.shiftKey ? big : step),
            PageUp: big,
            PageDown: -big,
        }
        if (!(e.key in delta)) return
        e.preventDefault()
        bump(delta[e.key])
    }

    const atLow = value != null && value <= lo
    const atHigh = value != null && value >= hi
    const stepperCls = cn(
        'grid place-items-center h-full w-8 shrink-0 text-ink-muted transition-colors',
        'hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
        'disabled:opacity-35 disabled:hover:bg-transparent disabled:cursor-not-allowed',
    )

    return (
        <div className={cn(CONTROL_SHELL, CONTROL_SIZE[size], 'overflow-hidden',
            wiring['aria-invalid'] && CONTROL_INVALID, off && CONTROL_DISABLED, className)}>
            {steppers && (
                <button type="button" tabIndex={-1} aria-label={name ? `Decrease ${name}` : 'Decrease'}
                    disabled={off || atLow} onClick={() => bump(-step)} className={cn(stepperCls, 'border-r border-glass-border/60')}>
                    <Minus className="w-3.5 h-3.5" aria-hidden />
                </button>
            )}
            <input
                type="text"
                role="spinbutton"
                inputMode={places > 0 ? 'decimal' : 'numeric'}
                autoComplete="off"
                spellCheck={false}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                aria-valuenow={value ?? undefined}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuetext={value == null ? undefined : valueText ? valueText(value) : `${show(value)}${unit ? ` ${unit}` : ''}`}
                placeholder={placeholder}
                value={text}
                {...wiring}
                onChange={(e) => {
                    const t = e.target.value
                    setDraft(t)
                    if (t.trim() === '') {
                        if (allowEmpty) send(null)
                        return
                    }
                    const n = read(t)
                    if (n !== null) send(n)
                }}
                onBlur={() => setDraft(null)}
                onKeyDown={onKeyDown}
                className={cn(
                    'h-full min-w-0 w-full flex-1 bg-transparent px-2.5 text-right tabular-nums outline-none',
                    'placeholder:text-ink-muted disabled:cursor-not-allowed',
                    inputClassName,
                )}
            />
            {unit && <span className="pr-2.5 -ml-1 text-xs font-medium text-ink-muted shrink-0 select-none">{unit}</span>}
            {steppers && (
                <button type="button" tabIndex={-1} aria-label={name ? `Increase ${name}` : 'Increase'}
                    disabled={off || atHigh} onClick={() => bump(step)} className={cn(stepperCls, 'border-l border-glass-border/60')}>
                    <Plus className="w-3.5 h-3.5" aria-hidden />
                </button>
            )}
        </div>
    )
}
