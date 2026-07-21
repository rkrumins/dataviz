import { describe, it, expect } from 'vitest'
import { normalizeIdentity, isIdentityOverridden, identityCoalesceExpr } from './NodeIdentity'

describe('normalizeIdentity', () => {
    it('treats empty / whitespace / null / undefined as the default "urn"', () => {
        expect(normalizeIdentity('')).toBe('urn')
        expect(normalizeIdentity('   ')).toBe('urn')
        expect(normalizeIdentity(null)).toBe('urn')
        expect(normalizeIdentity(undefined)).toBe('urn')
    })
    it('trims a real value', () => {
        expect(normalizeIdentity('  id ')).toBe('id')
        expect(normalizeIdentity('urn')).toBe('urn')
    })
})

describe('isIdentityOverridden', () => {
    it('is false for the default and empties, true for a real mapping', () => {
        expect(isIdentityOverridden('')).toBe(false)
        expect(isIdentityOverridden('urn')).toBe(false)
        expect(isIdentityOverridden('  ')).toBe(false)
        expect(isIdentityOverridden(null)).toBe(false)
        expect(isIdentityOverridden('id')).toBe(true)
        expect(isIdentityOverridden(' name ')).toBe(true)
    })
})

describe('identityCoalesceExpr', () => {
    it('renders plain n.urn for the default', () => {
        expect(identityCoalesceExpr('')).toBe('n.urn')
        expect(identityCoalesceExpr('urn')).toBe('n.urn')
        expect(identityCoalesceExpr(undefined)).toBe('n.urn')
    })
    it('renders a coalesce fallback for a mapped property', () => {
        expect(identityCoalesceExpr('id')).toBe('coalesce(n.urn, n.id)')
        expect(identityCoalesceExpr('  externalId ')).toBe('coalesce(n.urn, n.externalId)')
    })
})
