/**
 * valueCodec — a typed value between the input the user edits and the
 * predicate that is sent.
 *
 * Inputs hold text. What goes on the wire depends on the type the row
 * compares as: a number is sent as a JSON number while a double holds it
 * exactly, and as its exact digits otherwise (the backend parses digits
 * into an int64 under `valueType: 'number'` — `Number()` would send a
 * neighbouring integer no entity carries). Booleans are sent as booleans,
 * dates and text as text.
 */
import type { PropertyOperator } from './operators'
import { arityOf, comparesAs } from './operators'
import type { ValueType } from './valueTypes'


const INTEGER = /^[+-]?\d+$/
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/


/** The wire value for one piece of typed text. Text that is not a value of
 *  the type is sent as typed — `valueProblem` says why the row is not
 *  applied, so it never reaches the server. */
export function toWire(text: string, type: ValueType): unknown {
    const t = text.trim()
    if (type === 'number') {
        if (INTEGER.test(t)) {
            const n = Number(t)
            return Number.isSafeInteger(n) ? n : t.replace(/^\+/, '')
        }
        if (DECIMAL.test(t)) return Number(t)
        return text
    }
    if (type === 'boolean') return t === 'true' ? true : t === 'false' ? false : text
    if (type === 'date') return t
    return text
}

/** The text an input shows for a wire value. */
export function toText(value: unknown): string {
    if (value === null || value === undefined) return ''
    return typeof value === 'string' ? value : String(value)
}

/** Re-encode a row's value for a new type: "15" ↔ 15, "true" ↔ true. */
export function recode(value: unknown, type: ValueType): unknown {
    if (Array.isArray(value)) return value.map((v) => recode(v, type))
    if (value === null || value === undefined || value === '') return value
    return toWire(toText(value), type)
}


function filled(v: unknown): boolean {
    return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '')
}

function problemWithOne(v: unknown, type: ValueType): string | null {
    if (type === 'number') {
        if (typeof v === 'number') return Number.isFinite(v) ? null : `${v} is not a number`
        return DECIMAL.test(toText(v).trim()) ? null : `"${toText(v)}" is not a number`
    }
    if (type === 'boolean') {
        return typeof v === 'boolean' || v === 'true' || v === 'false' ? null : 'choose true or false'
    }
    if (type === 'date') {
        const t = toText(v).trim()
        return DAY.test(t) || DATE_TIME.test(t) ? null : `"${t}" is not a date — use YYYY-MM-DD`
    }
    return null
}

/** Why a row is not a filter yet — or null when it is. A row with a problem
 *  is not run: an empty value used to compile to `CONTAINS ''` and match
 *  every entity carrying the key. `type` is the row's property type; the
 *  operator decides what it compares as. Under `auto` only presence is
 *  checked — the value decides its own type. */
export function valueProblem(
    op: PropertyOperator, type: ValueType | 'auto', value: unknown,
): string | null {
    const arity = arityOf(op)
    if (arity === 'none') return null
    if (arity === 'duration') return isDuration(value) ? null : 'enter how far back to look'
    const kind = type === 'auto' ? null : comparesAs(op, type)
    const check = (v: unknown) => (kind ? problemWithOne(v, kind) : null)
    if (arity === 'many') {
        const items = (Array.isArray(value) ? value : [value]).filter(filled)
        if (items.length === 0) return 'choose at least one value'
        for (const item of items) {
            const problem = check(item)
            if (problem) return problem
        }
        return null
    }
    if (arity === 'pair') {
        if (!Array.isArray(value) || value.length !== 2 || !value.every(filled)) {
            return 'enter both ends of the range'
        }
        return check(value[0]) ?? check(value[1])
    }
    if (!filled(value)) return 'enter a value'
    return check(value)
}


// ---------------------------------------------------------------------------
// Durations — `withinLast` takes an ISO 8601 duration ("P30D")
// ---------------------------------------------------------------------------

export type DurationUnit = 'hours' | 'days' | 'weeks' | 'months' | 'years'

const UNIT_CODE: Record<DurationUnit, string> = {
    hours: 'H', days: 'D', weeks: 'W', months: 'M', years: 'Y',
}

export const DURATION_UNITS: readonly DurationUnit[] = ['hours', 'days', 'weeks', 'months', 'years']

// The backend's grammar: any of years, months, weeks, days, then a time part.
const DURATION = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/i

function isDuration(value: unknown): boolean {
    const t = toText(value).trim()
    return DURATION.test(t) && /\d/.test(t) && !/T$/i.test(t)
}

export function toDuration(amount: number, unit: DurationUnit): string {
    return unit === 'hours' ? `PT${amount}H` : `P${amount}${UNIT_CODE[unit]}`
}

/** `{amount, unit}` for the one-unit durations the editor writes — the
 *  backend accepts combinations too ("P1DT6H"), which read as null here. */
export function parseDuration(value: unknown): { amount: number; unit: DurationUnit } | null {
    const m = /^P(?:(\d+)([DWMY])|T(\d+)H)$/i.exec(toText(value).trim())
    if (!m) return null
    if (m[3] !== undefined) return { amount: Number(m[3]), unit: 'hours' }
    const unit = (Object.keys(UNIT_CODE) as DurationUnit[])
        .find((u) => u !== 'hours' && UNIT_CODE[u] === m[2].toUpperCase())
    return unit ? { amount: Number(m[1]), unit } : null
}

/** "30 days", "1 week" — a duration in words. */
export function describeDuration(value: unknown): string | null {
    const d = parseDuration(value)
    if (!d) return null
    const unit = d.amount === 1 ? d.unit.slice(0, -1) : d.unit
    return `${d.amount} ${unit}`
}
