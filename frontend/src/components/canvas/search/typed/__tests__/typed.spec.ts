/**
 * The typed value contract, browser side: what a property is guessed to
 * hold, which operators it offers and how they read, and what a typed value
 * is sent as. The backend defines what the operators MEAN
 * (`backend/common/search_semantics.py`); these tests pin that the browser
 * sends values it can compare exactly and never offers an operator the
 * backend's table does not know.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'

import {
    arityOf,
    autoTypeOf,
    comparesAs,
    isNegative,
    operatorLabel,
    operatorsFor,
    predicateType,
} from '../operators'
import {
    describeDuration,
    parseDuration,
    recode,
    toDuration,
    toWire,
    valueProblem,
} from '../valueCodec'
import { VALUE_TYPES, observeType } from '../valueTypes'


const ALL_OPS = Object.keys(OPERATOR_TABLE) as PropertyOperator[]


describe('observeType — the first guess at how a property compares', () => {
    it('takes the kind most samples have', () => {
        expect(observeType([1, 2, 'n/a'])).toEqual({ type: 'number', mixed: true, list: false })
        expect(observeType(['a', 'b'])).toEqual({ type: 'string', mixed: false, list: false })
        expect(observeType([true, false])).toMatchObject({ type: 'boolean' })
        expect(observeType([])).toEqual({ type: 'string', mixed: false, list: false })
    })

    it('reads text by what it spells', () => {
        // An int64 arrives as its exact digits (lib/losslessJson).
        expect(observeType(['-3746471915534727923', '15']).type).toBe('number')
        expect(observeType(['2024-05-01', '2024-05-01T10:00:00Z']).type).toBe('date')
        expect(observeType(['A-1', '007-x']).type).toBe('string')
    })

    it('sees list values element by element', () => {
        expect(observeType([['pii', 'gold'], ['x']])).toEqual({ type: 'string', mixed: false, list: true })
        expect(observeType([[1, 2]])).toMatchObject({ type: 'number', list: true })
    })
})


describe('operators — offered from the backend table, in words', () => {
    it('offers every operator the backend knows somewhere, and nothing else', () => {
        const offered = new Set<string>()
        for (const type of VALUE_TYPES) {
            for (const list of [false, true]) {
                for (const choice of operatorsFor(type, { list })) {
                    expect(OPERATOR_TABLE).toHaveProperty(choice.value)
                    offered.add(choice.value)
                }
            }
        }
        expect([...offered].sort()).toEqual([...ALL_OPS].sort())
    })

    it('every offered operator compares as a type the backend accepts for it', () => {
        for (const type of VALUE_TYPES) {
            for (const { value: op } of operatorsFor(type, { list: true })) {
                const accepted = OPERATOR_TABLE[op].types as readonly string[]
                if (accepted.length > 0) expect(accepted).toContain(comparesAs(op, type))
            }
        }
    })

    it('keeps an operator the menu would not offer when a row already has it', () => {
        const ops = operatorsFor('boolean', { current: 'gt' }).map((o) => o.value)
        expect(ops).toContain('gt')
    })

    it('reads by type and by list', () => {
        expect(operatorLabel('gte', 'date')).toBe('is on or after')
        expect(operatorLabel('gte', 'number')).toBe('is at least')
        expect(operatorLabel('eq', 'string', true)).toBe('has')
        expect(operatorLabel('in', 'string', true)).toBe('has any of')
        expect(operatorsFor('string', { list: true }).map((o) => o.value)).toContain('containsAll')
        expect(operatorsFor('string').map((o) => o.value)).not.toContain('containsAll')
    })

    it('text operators stay on number properties — digits are text too', () => {
        const ops = operatorsFor('number').map((o) => o.value)
        expect(ops).toContain('contains')
        expect(comparesAs('contains', 'number')).toBe('string')
        expect(comparesAs('withinLast', 'string')).toBe('date')
        expect(comparesAs('gt', 'number')).toBe('number')
    })

    it('arity and negativity come from the table', () => {
        expect(arityOf('between')).toBe('pair')
        expect(arityOf('isEmpty')).toBe('none')
        expect(arityOf('withinLast')).toBe('duration')
        expect(ALL_OPS.filter(isNegative).sort()).toEqual(['neq', 'notContains', 'notIn'])
    })

    // The backend's `auto` inference (search_semantics._resolve_type),
    // case for case — the DSL writes a type only where this would differ.
    it.each([
        ['eq', '15', 'string'], ['eq', 15, 'number'], ['eq', 1.5, 'number'],
        ['eq', true, 'boolean'], ['gt', '10', 'number'], ['gt', '2024-05-01', 'date'],
        ['gt', 'm', 'string'], ['between', ['1', '16'], 'number'], ['in', ['a', 1], 'string'],
        ['in', [1, 2.5], 'number'], ['contains', 74, 'string'], ['withinLast', 'P30D', 'date'],
    ] as const)('auto: %s %j compares as %s', (op, value, type) => {
        expect(autoTypeOf(op, value)).toBe(type)
    })

    it('a declared type wins over the value', () => {
        expect(predicateType({ op: 'eq', value: '15', valueType: 'number' })).toBe('number')
        expect(predicateType({ op: 'eq', value: '15', valueType: 'auto' })).toBe('string')
        expect(predicateType({ op: 'eq', value: '15' })).toBe('string')
    })
})


describe('valueCodec — what a typed value is sent as', () => {
    it('sends a number as a number while a double holds it exactly', () => {
        expect(toWire('15', 'number')).toBe(15)
        expect(toWire(' 007 ', 'number')).toBe(7)
        expect(toWire('1.5', 'number')).toBe(1.5)
        expect(toWire('-3746471915534727923', 'number')).toBe('-3746471915534727923')
        expect(toWire('+9223372036854775807', 'number')).toBe('9223372036854775807')
    })

    it('sends every integer past 2^53 as its exact digits', () => {
        const unsafe = fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
            .filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER))
        fc.assert(fc.property(unsafe, (b) => {
            expect(toWire(b.toString(), 'number')).toBe(b.toString())
        }))
    })

    it('keeps text, booleans and dates as what they are', () => {
        expect(toWire('007', 'string')).toBe('007')
        expect(toWire('true', 'boolean')).toBe(true)
        expect(toWire('false', 'boolean')).toBe(false)
        expect(toWire(' 2024-05-01 ', 'date')).toBe('2024-05-01')
    })

    it('re-reads a value for a new type', () => {
        expect(recode('15', 'number')).toBe(15)
        expect(recode(15, 'string')).toBe('15')
        expect(recode(['1', '2'], 'number')).toEqual([1, 2])
        expect(recode('', 'number')).toBe('')
    })

    it('says why a row is not a filter yet', () => {
        expect(valueProblem('eq', 'string', '')).toBe('enter a value')
        expect(valueProblem('eq', 'number', 'abc')).toBe('"abc" is not a number')
        expect(valueProblem('eq', 'number', '-3746471915534727923')).toBeNull()
        expect(valueProblem('eq', 'boolean', 'yes')).toBe('choose true or false')
        expect(valueProblem('gt', 'date', '01/05/2024')).toMatch(/is not a date/)
        expect(valueProblem('in', 'string', [])).toBe('choose at least one value')
        expect(valueProblem('between', 'number', [1, ''])).toBe('enter both ends of the range')
        expect(valueProblem('between', 'number', [1, 'x'])).toBe('"x" is not a number')
        expect(valueProblem('isEmpty', 'string', undefined)).toBeNull()
        expect(valueProblem('withinLast', 'date', '')).toBe('enter how far back to look')
        expect(valueProblem('withinLast', 'date', 'P1DT6H')).toBeNull()
        // A text operator reads text whatever the property holds.
        expect(valueProblem('contains', 'number', '74')).toBeNull()
        // Before types, only presence is checked — the value decides.
        expect(valueProblem('gt', 'auto', 'abc')).toBeNull()
    })

    it('writes and reads durations', () => {
        expect(toDuration(30, 'days')).toBe('P30D')
        expect(toDuration(12, 'hours')).toBe('PT12H')
        expect(parseDuration('P2W')).toEqual({ amount: 2, unit: 'weeks' })
        expect(parseDuration('pt3h')).toEqual({ amount: 3, unit: 'hours' })
        expect(parseDuration('P1DT6H')).toBeNull()
        expect(describeDuration('P1M')).toBe('1 month')
        expect(describeDuration('P30D')).toBe('30 days')
    })
})
