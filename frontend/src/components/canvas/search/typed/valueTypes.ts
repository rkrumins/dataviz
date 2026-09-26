/**
 * valueTypes — what kind of value a property holds, and so how a search
 * row should compare it.
 *
 * The backend reads every stored value AS the comparison's type
 * (`backend/common/search_semantics.py`): under `number` a stored "15" is
 * 15, under `string` a stored 15 is "15". Which type a row compares as is
 * therefore a choice. This module makes the first guess from the property's
 * sampled values — mostly numbers → number, ISO dates → date — and the row
 * lets the user override it. Whatever is chosen is stamped on the predicate
 * (`valueType`), so a saved query or display rule keeps its meaning when
 * the data under it drifts.
 */
import { Calendar, Hash, ToggleLeft, Type, type LucideIcon } from 'lucide-react'

import type { ComparisonType } from '@/types/generated/searchOperators'


export type ValueType = ComparisonType

export interface ObservedType {
    /** The type most sampled values have — what a new row compares as. */
    type: ValueType
    /** Samples disagree (a number column with the odd "n/a" in it). */
    mixed: boolean
    /** Samples are lists — operators read "has" rather than "is". */
    list: boolean
}

// ISO 8601 as data sources write it: a day, optionally a time, optionally
// fractional seconds and an offset. The backend compares these as dates.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

// Text the backend reads as a number under `number`: an integer (digits of
// any length — an int64 arrives as its exact digits, see lib/losslessJson)
// or a decimal with a point.
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/


function kindOf(v: unknown): ValueType | null {
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'number') return Number.isFinite(v) ? 'number' : null
    if (typeof v !== 'string') return null
    const t = v.trim()
    if (t === '') return null
    if (ISO_DATE.test(t)) return 'date'
    if (NUMBER_TEXT.test(t)) return 'number'
    return 'string'
}


/** The type most samples have (text when there are none), whether they
 *  disagree, and whether the property holds lists. */
export function observeType(samples: readonly unknown[]): ObservedType {
    const counts = new Map<ValueType, number>()
    let list = false
    for (const sample of samples) {
        if (Array.isArray(sample)) list = true
        for (const item of Array.isArray(sample) ? sample : [sample]) {
            const kind = kindOf(item)
            if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
        }
    }
    let type: ValueType = 'string'
    let most = 0
    for (const [kind, n] of counts) {
        if (n > most) { type = kind; most = n }
    }
    return { type, mixed: counts.size > 1, list }
}


export interface TypeMeta {
    label: string
    Icon: LucideIcon
    /** One line on how values of this type compare. */
    description: string
}

export const TYPE_META: Record<ValueType, TypeMeta> = {
    string: { label: 'Text', Icon: Type, description: 'Compares text — any value reads as its text' },
    number: { label: 'Number', Icon: Hash, description: 'Compares numbers — "15" in the data is 15' },
    boolean: { label: 'True / false', Icon: ToggleLeft, description: 'Compares true or false' },
    date: { label: 'Date', Icon: Calendar, description: 'Compares ISO dates and times' },
}

export const VALUE_TYPES: readonly ValueType[] = ['string', 'number', 'boolean', 'date']
