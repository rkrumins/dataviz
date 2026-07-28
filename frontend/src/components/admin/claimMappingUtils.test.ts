import { describe, expect, it } from 'vitest'
import { asKeyList, detectKeys, extrasOf, previewDecode } from './claimMappingUtils'

describe('detectKeys', () => {
    it('lists top-level keys sorted', () => {
        expect(detectKeys({ sub: 'a', email: 'b' })).toEqual(['email', 'sub'])
    })

    it('reaches one level of nesting, matching what the provider hoists', () => {
        expect(detectKeys({ sub: 'a', user: { firstName: 'A', lastName: 'B' } }))
            .toEqual(['firstName', 'lastName', 'sub', 'user'])
    })

    it('does not descend into arrays', () => {
        expect(detectKeys({ groups: ['a', 'b'] })).toEqual(['groups'])
    })

    it.each([null, undefined, 'a string', 42, ['a']])(
        'returns [] for non-object input (%s)', (input) => {
            expect(detectKeys(input)).toEqual([])
        },
    )
})

describe('previewDecode', () => {
    it('parses plain JSON', () => {
        expect(previewDecode('{"a": 1}')).toEqual({ a: 1 })
    })

    it('decodes a JWT body without verifying the signature', () => {
        // header.payload.signature — the signature is deliberately junk;
        // preview must not care, verification happens server-side.
        const body = btoa(JSON.stringify({ sub: 'u1', email: 'a@corp.example' }))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        expect(previewDecode(`eyJhbGciOiJIUzI1NiJ9.${body}.not-a-real-signature`))
            .toEqual({ sub: 'u1', email: 'a@corp.example' })
    })

    it('returns null for empty or unparseable input', () => {
        expect(previewDecode('')).toBeNull()
        expect(previewDecode('   ')).toBeNull()
        expect(previewDecode('not json at all')).toBeNull()
    })
})

describe('asKeyList', () => {
    it('keeps string arrays and drops non-strings', () => {
        expect(asKeyList(['a', 1, 'b'])).toEqual(['a', 'b'])
    })

    it('wraps a bare string, for hand-edited configs', () => {
        expect(asKeyList('sub')).toEqual(['sub'])
    })

    it('returns [] for anything else', () => {
        expect(asKeyList(undefined)).toEqual([])
        expect(asKeyList({})).toEqual([])
        expect(asKeyList('')).toEqual([])
    })
})

describe('extrasOf', () => {
    it('normalises every entry to a candidate list', () => {
        expect(extrasOf({ extras: { dept: ['department'], staff: 'staffNumber' } }))
            .toEqual({ dept: ['department'], staff: ['staffNumber'] })
    })

    it('returns {} when extras is missing or the wrong shape', () => {
        expect(extrasOf({})).toEqual({})
        expect(extrasOf({ extras: ['nope'] })).toEqual({})
        expect(extrasOf({ extras: 'nope' })).toEqual({})
    })
})
