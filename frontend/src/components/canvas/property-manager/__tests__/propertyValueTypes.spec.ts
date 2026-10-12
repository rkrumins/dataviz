import { describe, expect, it } from 'vitest'

import { storedType } from '../propertyValueTypes'


describe('storedType', () => {
    it('is the kind most entities store the key as', () => {
        expect(storedType({ String: 3, Integer: 40 })).toEqual({ type: 'number', mixed: true })
        expect(storedType({ Boolean: 799448, String: 200552 })).toEqual({ type: 'boolean', mixed: true })
    })

    it('counts integers and decimals as one type: they compare as numbers', () => {
        expect(storedType({ Integer: 5, Float: 2 })).toEqual({ type: 'number', mixed: false })
    })

    it('knows lists', () => {
        expect(storedType({ List: 10 })).toEqual({ type: 'list', mixed: false })
    })

    it('is null when nothing is known', () => {
        expect(storedType({})).toEqual({ type: null, mixed: false })
    })
})
