/**
 * TypedValueEditor — the VALUE of a property row, shaped by what the
 * operator takes and the type it compares as.
 *
 *   one value    text · number → sampled values to pick, any value to type
 *                true / false  → a two-way toggle
 *                date          → a date, and a time when one is wanted
 *   many values  chips — paste a list and each line becomes one
 *   a range      two typed ends, "from … and …"
 *   a duration   an amount and a unit — "30 days"
 *   nothing      presence operators take no value
 *
 * It emits WIRE values (`valueCodec.toWire`): a number as a number while a
 * double holds it exactly and as its digits otherwise, true/false as
 * booleans, dates as ISO text.
 */
import { Clock, X } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'

import { cn } from '@/lib/utils'
import type { SearchValueSuggestion } from '@/types/search'

import { type PickerOption, UnifiedPicker } from '../builder/editors/UnifiedPicker'
import { OperatorMenu } from '../panel/OperatorMenu'

import { arityOf, comparesAs, type PropertyOperator } from './operators'
import { inputClass } from './fieldStyles'
import {
    DURATION_UNITS,
    type DurationUnit,
    parseDuration,
    toDuration,
    toText,
    toWire,
} from './valueCodec'
import type { ValueType } from './valueTypes'


export interface TypedValueEditorProps {
    op: PropertyOperator
    /** The row's property type — the operator decides what it compares as. */
    type: ValueType
    value: unknown
    onChange: (next: unknown) => void
    /** Sampled stored values of the property — offered when there are no
     *  counted suggestions. */
    samples: readonly unknown[]
    /** The property's most common values across the view, with counts. */
    suggestions?: readonly SearchValueSuggestion[] | null
    /** The text being typed in a value picker — for fetching suggestions.
     *  When set, the picker stays mounted while they load. */
    onQueryChange?: (query: string) => void
    /** Enter in a single-value field runs the query. */
    onSubmit?: () => void
}

export function TypedValueEditor({
    op, type, value, onChange, samples, suggestions, onQueryChange, onSubmit,
}: TypedValueEditorProps) {
    const kind = comparesAs(op, type)
    const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && onSubmit) {
            e.preventDefault()
            onSubmit()
        }
    }
    switch (arityOf(op)) {
        case 'none':
            return null
        case 'duration':
            return <DurationInput value={value} onChange={onChange} onEnter={onEnter} />
        case 'pair':
            return <RangeInputs kind={kind} value={value} onChange={onChange} onEnter={onEnter} />
        case 'many':
            return (
                <UnifiedPicker
                    multiple
                    value={(Array.isArray(value) ? value : [value]).map(toText).filter((t) => t.trim() !== '')}
                    onChange={(next) => onChange(next.map((t) => toWire(t, kind)))}
                    options={kind === 'boolean' ? ['true', 'false'] : pickerOptions(samples, suggestions)}
                    onQueryChange={onQueryChange}
                    placeholder="pick samples or type values — paste a list…"
                    emptyHint="No samples discovered — type a value and press Enter."
                    mono={kind === 'number'}
                    portal
                />
            )
        default:
            if (kind === 'boolean') return <BooleanToggle value={value} onChange={onChange} />
            if (kind === 'date') return <DateInput value={value} onChange={onChange} onEnter={onEnter} />
            return (
                <SingleValue
                    kind={kind}
                    value={value}
                    onChange={onChange}
                    options={pickerOptions(samples, suggestions)}
                    onQueryChange={onQueryChange}
                    onEnter={onEnter}
                />
            )
    }
}


/** What a value picker lists: the counted suggestions, or else the sampled
 *  values. Values that print the same (15 and "15") are one option — the
 *  row's type decides what the text is sent as. */
function pickerOptions(
    samples: readonly unknown[], suggestions: readonly SearchValueSuggestion[] | null | undefined,
): PickerOption[] {
    if (!suggestions || suggestions.length === 0) return sampleTexts(samples).map((v) => ({ value: v }))
    const counts = new Map<string, number>()
    for (const s of suggestions) {
        const text = toText(s.value)
        if (text.trim() !== '') counts.set(text, (counts.get(text) ?? 0) + s.count)
    }
    return [...counts].map(([text, count]) => ({ value: text, count }))
}


/** Distinct sampled values as text — list elements one by one. */
function sampleTexts(samples: readonly unknown[]): string[] {
    const out = new Set<string>()
    for (const sample of samples) {
        for (const v of Array.isArray(sample) ? sample : [sample]) {
            if (v === null || v === undefined) continue
            const text = typeof v === 'object' ? JSON.stringify(v) : String(v)
            if (text.trim() !== '') out.add(text)
        }
    }
    return [...out]
}


function SingleValue({
    kind, value, onChange, options, onQueryChange, onEnter,
}: {
    kind: ValueType
    value: unknown
    onChange: (next: unknown) => void
    options: PickerOption[]
    onQueryChange?: (query: string) => void
    onEnter: (e: KeyboardEvent<HTMLInputElement>) => void
}) {
    // With a live source the picker stays mounted: swapping the plain
    // field for it when the first suggestions land would take the focus
    // out from under someone typing.
    if (options.length > 0 || onQueryChange) {
        return (
            <UnifiedPicker
                value={toText(value)}
                onChange={(next) => onChange(toWire(next, kind))}
                options={options}
                onQueryChange={onQueryChange}
                placeholder="pick a value or type any value…"
                emptyHint="No values found yet — type a value."
                mono={kind === 'number'}
                portal
            />
        )
    }
    return (
        <input
            type="text"
            inputMode={kind === 'number' ? 'decimal' : undefined}
            value={toText(value)}
            onChange={(e) => onChange(toWire(e.target.value, kind))}
            onKeyDown={onEnter}
            placeholder="type a value…"
            className={cn(inputClass, kind === 'number' && 'tabular-nums font-mono')}
        />
    )
}


function BooleanToggle({ value, onChange }: { value: unknown; onChange: (next: boolean) => void }) {
    const current = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null
    return (
        <div role="radiogroup" aria-label="True or false" className="inline-flex rounded-lg border border-glass-border p-0.5 w-fit">
            {[true, false].map((option) => (
                <button
                    key={String(option)}
                    type="button"
                    role="radio"
                    aria-checked={current === option}
                    onClick={() => onChange(option)}
                    className={cn(
                        'px-4 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
                        current === option
                            ? 'bg-accent-lineage/15 text-accent-lineage shadow-sm'
                            : 'text-ink-muted hover:text-ink',
                    )}
                >
                    {option ? 'True' : 'False'}
                </button>
            ))}
        </div>
    )
}


// A time the user picks is local; it is sent in UTC ("…Z"), the form data
// sources overwhelmingly store timestamps in.
function localInputValue(iso: string): string {
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return iso.replace(' ', 'T').slice(0, 16)
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function utcFromLocal(local: string): string {
    const d = new Date(local)
    return Number.isNaN(d.getTime()) ? local : d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function DateInput({
    value, onChange, onEnter, ariaLabel,
}: {
    value: unknown
    onChange: (next: string) => void
    onEnter: (e: KeyboardEvent<HTMLInputElement>) => void
    ariaLabel?: string
}) {
    const text = toText(value).trim()
    const withTime = text.length > 10
    return (
        <div className="flex items-center gap-2">
            <input
                type={withTime ? 'datetime-local' : 'date'}
                value={withTime ? localInputValue(text) : text}
                onChange={(e) => onChange(withTime ? utcFromLocal(e.target.value) : e.target.value)}
                onKeyDown={onEnter}
                aria-label={ariaLabel ?? (withTime ? 'Date and time' : 'Date')}
                className={cn(inputClass, 'tabular-nums')}
            />
            <button
                type="button"
                onClick={() => onChange(withTime ? text.slice(0, 10) : text ? utcFromLocal(`${text}T00:00`) : '')}
                title={withTime ? 'Compare whole days' : 'Compare to the minute — in your time zone'}
                aria-label={withTime ? 'Remove time' : 'Add a time'}
                className={cn(
                    'shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px]',
                    'border border-glass-border text-ink-muted hover:text-ink transition-colors',
                )}
            >
                {withTime ? <X className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                {withTime ? 'Day only' : 'Time'}
            </button>
        </div>
    )
}


/** Both ends of a `between`, kept as typed — never through `Number(x) || 0`,
 *  which rounded long ids and turned an empty end into a silent 0. */
function RangeInputs({
    kind, value, onChange, onEnter,
}: {
    kind: ValueType
    value: unknown
    onChange: (next: [unknown, unknown]) => void
    onEnter: (e: KeyboardEvent<HTMLInputElement>) => void
}) {
    const pair = Array.isArray(value) ? value : []
    const [lo, hi] = [pair[0], pair[1]]
    if (kind === 'date') {
        return (
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <DateInput value={lo} onChange={(v) => onChange([v, hi])} onEnter={onEnter} ariaLabel="Range from" />
                <span className="text-[11px] text-ink-muted">and</span>
                <DateInput value={hi} onChange={(v) => onChange([lo, v])} onEnter={onEnter} ariaLabel="Range to" />
            </div>
        )
    }
    const field = (v: unknown, label: string, set: (text: string) => void) => (
        <input
            type="text"
            inputMode={kind === 'number' ? 'decimal' : undefined}
            value={toText(v)}
            onChange={(e) => set(e.target.value)}
            onKeyDown={onEnter}
            placeholder={label === 'Range from' ? 'from' : 'to'}
            aria-label={label}
            className={cn(inputClass, 'tabular-nums')}
        />
    )
    return (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            {field(lo, 'Range from', (t) => onChange([toWire(t, kind), hi]))}
            <span className="text-[11px] text-ink-muted">and</span>
            {field(hi, 'Range to', (t) => onChange([lo, toWire(t, kind)]))}
        </div>
    )
}


const UNIT_OPTIONS = DURATION_UNITS.map((unit) => ({ value: unit, label: unit }))

function DurationInput({
    value, onChange, onEnter,
}: {
    value: unknown
    onChange: (next: string) => void
    onEnter: (e: KeyboardEvent<HTMLInputElement>) => void
}) {
    const parsed = parseDuration(value)
    // The unit is kept while the amount is empty — there is no duration to
    // hold it in yet.
    const [pickedUnit, setPickedUnit] = useState<DurationUnit>(parsed?.unit ?? 'days')
    const unit: DurationUnit = parsed?.unit ?? pickedUnit
    const amount = parsed ? String(parsed.amount) : ''
    const emit = (nextAmount: string, nextUnit: DurationUnit) => {
        setPickedUnit(nextUnit)
        const n = Number(nextAmount)
        onChange(nextAmount.trim() !== '' && Number.isInteger(n) && n >= 0 ? toDuration(n, nextUnit) : '')
    }
    return (
        <div className="flex items-center gap-2">
            <input
                type="text"
                inputMode="numeric"
                value={amount}
                onChange={(e) => emit(e.target.value, unit)}
                onKeyDown={onEnter}
                placeholder="30"
                aria-label="How many"
                className={cn(inputClass, 'w-24 tabular-nums')}
            />
            <OperatorMenu
                value={unit}
                onChange={(next) => emit(amount, next)}
                options={UNIT_OPTIONS}
                ariaLabel="Unit"
            />
        </div>
    )
}
