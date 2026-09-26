/**
 * operators — the property operators a row offers, in plain words.
 *
 * What each operator TAKES and COMPARES AS is not defined here: it comes
 * from the backend's operator table (`search_semantics.OPERATOR_TABLE`,
 * generated into `@/types/generated/searchOperators`), so the browser and
 * the server cannot disagree about it. This module adds what only the UI
 * needs — which operators suit a type, in what order, and how to say each
 * one ("is on or after" for a date, "has any of" for a list).
 */
import {
    OPERATOR_TABLE,
    type OperatorArity,
    type PropertyOperator,
} from '@/types/generated/searchOperators'

import type { ValueType } from './valueTypes'


export type { OperatorArity, PropertyOperator }


export function arityOf(op: PropertyOperator): OperatorArity {
    return OPERATOR_TABLE[op].arity
}

/** Matches by absence (≠, is none of, does not contain) — the operators
 *  for which "entities without the property" needs a decision. */
export function isNegative(op: PropertyOperator): boolean {
    return OPERATOR_TABLE[op].negative
}

/** The type a comparison actually runs as. An operator with one type always
 *  compares as it — "contains" reads the digits of a number as text, "within
 *  the last" reads dates — whatever the property holds. */
export function comparesAs(op: PropertyOperator, type: ValueType): ValueType {
    const types = OPERATOR_TABLE[op].types as readonly ValueType[]
    if (types.length === 1) return types[0]
    return types.length === 0 || types.includes(type) ? type : types[0]
}


const NUMBER_TEXT = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/
const DATE_TEXT = /^\s*\d{4}-\d{2}-\d{2}(?:[T ].*)?$/
const ORDER_OPS = new Set<PropertyOperator>(['gt', 'gte', 'lt', 'lte', 'between'])

/** What `valueType: 'auto'` compares as — the value decides. Mirrors the
 *  backend's `_resolve_type`: text stays text for equality (exact for any
 *  integer); only the order operators read numeric or ISO-date text as a
 *  number or date. */
export function autoTypeOf(op: PropertyOperator, value: unknown): ValueType {
    const types = OPERATOR_TABLE[op].types as readonly ValueType[]
    if (types.length === 1) return types[0]
    const items = (Array.isArray(value) ? value : [value])
        .filter((v) => v !== null && v !== undefined && v !== '')
    if (items.length === 0) return 'string'
    if (items.every((v) => typeof v === 'boolean')) return 'boolean'
    if (items.every((v) => typeof v === 'number')) return 'number'
    if (ORDER_OPS.has(op) && items.every((v) => typeof v === 'string')) {
        if (items.every((v) => NUMBER_TEXT.test(v as string))) return 'number'
        if (items.every((v) => DATE_TEXT.test(v as string))) return 'date'
    }
    return 'string'
}


/** The type a predicate compares as: its declared type, or — for one
 *  written before types — what its value makes it. */
export function predicateType(p: { op?: PropertyOperator; value?: unknown; valueType?: string }): ValueType {
    const declared = p.valueType
    if (declared && declared !== 'auto') return declared as ValueType
    return autoTypeOf(p.op ?? 'eq', p.value)
}


// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

const PRESENCE: PropertyOperator[] = ['isSet', 'isNotSet']
const BLANKS: PropertyOperator[] = ['isEmpty', 'isNotEmpty']

/** The operators each type offers, most used first. The text operators stay
 *  on number properties: "gvHash contains 74" means its digits. */
const MENU: Record<ValueType, PropertyOperator[]> = {
    string: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith',
        'in', 'notIn', ...BLANKS, ...PRESENCE],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn',
        'contains', 'startsWith', 'endsWith', ...PRESENCE],
    boolean: ['eq', 'neq', ...PRESENCE],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'withinLast', ...PRESENCE],
}

export interface OperatorChoice {
    value: PropertyOperator
    label: string
    description?: string
}

/** The operator menu for a property of this type. A list property reads
 *  "has any of" / "has all of"; the current operator is always offered, so
 *  a row written elsewhere (Code mode, an import) never loses it. */
export function operatorsFor(
    type: ValueType, opts: { list?: boolean; current?: PropertyOperator } = {},
): OperatorChoice[] {
    const ops = [...MENU[type]]
    if (opts.list && (type === 'string' || type === 'number')) {
        ops.splice(ops.indexOf('in') + 1, 0, 'containsAll')
        if (type === 'number') ops.push(...BLANKS)
    }
    if (opts.current && !ops.includes(opts.current)) ops.push(opts.current)
    return ops.map((op) => ({
        value: op,
        label: operatorLabel(op, type, opts.list),
        description: DESCRIPTIONS[op]?.(type),
    }))
}

/** The operator in words, for the menu, the sentence and the chips. */
export function operatorLabel(op: PropertyOperator, type: ValueType, list = false): string {
    const date = type === 'date'
    switch (op) {
        case 'eq': return list ? 'has' : date ? 'is on' : type === 'number' ? 'equals' : 'is'
        case 'neq': return list ? 'does not have' : date ? 'is not on'
            : type === 'number' ? 'does not equal' : 'is not'
        case 'gt': return date ? 'is after' : 'is greater than'
        case 'gte': return date ? 'is on or after' : 'is at least'
        case 'lt': return date ? 'is before' : 'is less than'
        case 'lte': return date ? 'is on or before' : 'is at most'
        case 'between': return 'is between'
        case 'in': return list ? 'has any of' : 'is one of'
        case 'notIn': return list ? 'has none of' : 'is none of'
        case 'containsAll': return 'has all of'
        case 'contains': return 'contains'
        case 'notContains': return 'does not contain'
        case 'startsWith': return 'starts with'
        case 'endsWith': return 'ends with'
        case 'withinLast': return 'is within the last'
        case 'isSet': return 'is set'
        case 'isNotSet': return 'is not set'
        case 'isEmpty': return 'is empty'
        case 'isNotEmpty': return 'is not empty'
    }
}

const DESCRIPTIONS: Partial<Record<PropertyOperator, (type: ValueType) => string>> = {
    neq: () => 'Leaves out entities without this property, unless you include them',
    notIn: () => 'Leaves out entities without this property, unless you include them',
    notContains: () => 'Leaves out entities without this property, unless you include them',
    contains: (t) => (t === 'string' ? 'Anywhere in the text' : 'Anywhere in its text — digits included'),
    startsWith: (t) => (t === 'string' ? 'At the start of the text' : 'At the start of its text'),
    endsWith: (t) => (t === 'string' ? 'At the end of the text' : 'At the end of its text'),
    between: () => 'Both ends included',
    in: () => 'Paste a list to match many values at once',
    containsAll: () => 'Every value you list must be there',
    withinLast: () => 'Relative to now — keeps up as time passes',
    isSet: () => 'Has this property, whatever its value',
    isNotSet: () => 'Does not have this property at all',
    isEmpty: () => 'Missing, blank text or an empty list',
    isNotEmpty: () => 'Has a value that is not blank',
}
