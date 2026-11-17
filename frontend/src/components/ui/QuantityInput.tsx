/**
 * QuantityInput — a number with its unit: "13 GB", "30 minutes".
 *
 * The value is always held in base units (bytes, seconds, milliseconds), so the unit is only how
 * it is shown and typed. Changing the unit re-shows the same value in it ("1 h" becomes "60 min");
 * it never changes the value. The unit it opens in is the largest the value is a round number of.
 */
import { useId, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatNumber, pickUnit, type QuantityUnit } from '@/lib/units'
import { useField } from './fieldContext'
import { NumberInput } from './NumberInput'
import { Select } from './Select'

export interface QuantityInputProps {
    /** In base units; null for no value. */
    value: number | null
    onChange: (value: number | null) => void
    units: QuantityUnit[]
    /** Spelled-out unit names, shown in the unit picker and spoken with the value ("1.5 hours"). */
    unitNames?: Record<string, string>
    defaultUnit?: string
    /** Bounds in base units. */
    min?: number
    max?: number
    /** Whole base units only (bytes, seconds). On by default. */
    integer?: boolean
    /** What the value is, for the steppers' and the unit picker's names. */
    name?: string
    /** The value to open the unit picker on, and to step from, while there is none. */
    fallback?: number
    allowEmpty?: boolean
    placeholder?: string
    size?: 'sm' | 'md'
    invalid?: boolean
    disabled?: boolean
    id?: string
    className?: string
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
}

export function QuantityInput({
    value, onChange, units, unitNames, defaultUnit, min, max, integer = true, name, fallback, allowEmpty,
    placeholder, size = 'md', invalid, disabled, id, className, ...aria
}: QuantityInputProps) {
    const [unitId, setUnitId] = useState(() => defaultUnit ?? pickUnit(value ?? fallback ?? 0, units).id)
    // The number takes the Field's id (its label points at it); the unit picker needs one of its own.
    const auto = useId()
    const field = useField()
    const unitPickerId = `${id ?? field?.controlId ?? auto}-unit`
    const unit = units.find((u) => u.id === unitId) ?? units[0]
    const shown = (n: number | null | undefined) => (n == null ? undefined : n / unit.factor)
    const spoken = (n: number) => `${formatNumber(n)} ${unitNames?.[unit.id] ?? unit.label}`
    // With no value, the fallback (an inherited value) shows in the chosen unit; the picker names it.
    const hint = placeholder ?? (fallback == null ? undefined : formatNumber(fallback / unit.factor))

    return (
        <div className={cn('flex items-stretch gap-1.5', className)}>
            <NumberInput
                {...aria}
                id={id}
                value={value == null ? null : value / unit.factor}
                onChange={(n) => onChange(n == null ? null : integer ? Math.round(n * unit.factor) : n * unit.factor)}
                min={shown(min)}
                max={shown(max)}
                fallback={shown(fallback)}
                decimals={unit.factor === 1 ? 0 : 2}
                name={name}
                valueText={spoken}
                allowEmpty={allowEmpty}
                placeholder={hint}
                size={size}
                invalid={invalid}
                disabled={disabled}
                className="flex-1 min-w-[7.5rem]"
            />
            <Select
                id={unitPickerId}
                aria-label={name ? `${name}: unit` : 'Unit'}
                size={size}
                value={unit.id}
                onChange={setUnitId}
                disabled={disabled}
                options={units.map((u) => ({ value: u.id, label: unitNames?.[u.id] ?? u.label }))}
                containerClassName={cn(unitNames ? 'w-[8.5rem]' : 'w-[4.75rem]', 'shrink-0')}
            />
        </div>
    )
}
