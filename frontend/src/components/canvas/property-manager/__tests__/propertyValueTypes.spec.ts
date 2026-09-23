import { describe, expect, it } from 'vitest'

import { inferType } from '../propertyValueTypes'


describe('inferType', () => {
    it('takes the kind most samples have, not the first one', () => {
        expect(inferType(['n/a', 3, 4, 5])).toBe('number')
        expect(inferType([true, 'yes', 'no'])).toBe('string')
    })

    it('reads an integer too long for a double (sent as its digits) as a number', () => {
        expect(inferType(['-3746471915534727923', '-4274918641463862057'])).toBe('number')
        expect(inferType(['02134', '10001'])).toBe('string')
    })

    it('is null when nothing is known', () => {
        expect(inferType([])).toBeNull()
        expect(inferType([null, undefined])).toBeNull()
    })
})
