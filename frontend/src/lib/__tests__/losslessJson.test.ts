import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseJsonLossless } from '../losslessJson'


describe('parseJsonLossless', () => {
    it('keeps an integer past 2^53 as its exact digits', () => {
        const out = parseJsonLossless<{ v: unknown; w: unknown }>(
            '{"v": -3746471915534727923, "w": 18446744073709551615}',
        )
        expect(out.v).toBe('-3746471915534727923')
        expect(out.w).toBe('18446744073709551615')
    })

    it('parses every other number exactly like JSON.parse', () => {
        const text = '{"a": 9007199254740991, "b": -9007199254740991, "c": 1.2345678901234567, '
            + '"d": 1e21, "e": 12345678901234567e2, "f": 0, "g": -1.5}'
        expect(parseJsonLossless(text)).toEqual(JSON.parse(text))
    })

    it('never touches digits inside strings, escapes included', () => {
        const text = '{"urn": "urn:li:dataset:12345678901234567890", '
            + '"q": "say \\"12345678901234567890\\" twice", "n": 12345678901234567890}'
        const out = parseJsonLossless<Record<string, unknown>>(text)
        expect(out.urn).toBe('urn:li:dataset:12345678901234567890')
        expect(out.q).toBe('say "12345678901234567890" twice')
        expect(out.n).toBe('12345678901234567890')
    })

    it('reaches nested arrays and objects', () => {
        const out = parseJsonLossless<{ hits: { properties: { ids: unknown[] } }[] }>(
            '{"hits":[{"properties":{"ids":[1,-3746471915534727923,2]}}]}',
        )
        expect(out.hits[0].properties.ids).toEqual([1, '-3746471915534727923', 2])
    })

    it('is JSON.parse for any document with only safe numbers', () => {
        // A whole number past 2^53 below 1e21 serialises as a plain digit run —
        // exactly what the parser is FOR (a Python server writes floats with a
        // '.' or an exponent, so such a run is always an integer there).
        const holdsUnsafeWholeNumber = (v: unknown): boolean => {
            if (typeof v === 'number') {
                return Number.isInteger(v) && !Number.isSafeInteger(v) && Math.abs(v) < 1e21
            }
            if (Array.isArray(v)) return v.some(holdsUnsafeWholeNumber)
            if (v && typeof v === 'object') return Object.values(v).some(holdsUnsafeWholeNumber)
            return false
        }
        fc.assert(fc.property(
            fc.jsonValue().filter((v) => !holdsUnsafeWholeNumber(v)),
            (value) => {
                const text = JSON.stringify(value)
                expect(parseJsonLossless(text)).toEqual(JSON.parse(text))
            },
        ), { numRuns: 500 })
    })

    it('returns every unsafe integer digit for digit', () => {
        const unsafe = fc.bigInt({ min: -(2n ** 63n), max: 2n ** 64n })
            .filter((b) => b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER))
        fc.assert(fc.property(fc.array(unsafe, { minLength: 1, maxLength: 5 }), (values) => {
            const text = `{"v":[${values.map(String).join(',')}]}`
            expect(parseJsonLossless<{ v: unknown[] }>(text).v).toEqual(values.map(String))
        }))
    })
})
