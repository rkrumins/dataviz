import { describe, it, expect } from 'vitest'
import {
    normalizeIdentity, isIdentityOverridden, identityCoalesceExpr,
    normalizeName, isNameOverridden, nameCoalesceExpr, isInherited,
} from './NodeIdentity'

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

describe('normalizeName', () => {
    it('treats empty / whitespace / null / undefined as the default "name"', () => {
        expect(normalizeName('')).toBe('name')
        expect(normalizeName('   ')).toBe('name')
        expect(normalizeName(null)).toBe('name')
        expect(normalizeName(undefined)).toBe('name')
    })
    it('trims a real value', () => {
        expect(normalizeName('  title ')).toBe('title')
        expect(normalizeName('name')).toBe('name')
    })
})

describe('isNameOverridden', () => {
    it('is false for the default and empties, true for a real mapping', () => {
        expect(isNameOverridden('')).toBe(false)
        expect(isNameOverridden('name')).toBe(false)
        expect(isNameOverridden('  ')).toBe(false)
        expect(isNameOverridden(null)).toBe(false)
        expect(isNameOverridden('title')).toBe(true)
        expect(isNameOverridden(' label ')).toBe(true)
    })
})

describe('nameCoalesceExpr', () => {
    it('renders plain n.name for the default', () => {
        expect(nameCoalesceExpr('')).toBe('n.name')
        expect(nameCoalesceExpr('name')).toBe('n.name')
        expect(nameCoalesceExpr(undefined)).toBe('n.name')
    })
    it('renders a displayName coalesce fallback for a mapped property', () => {
        expect(nameCoalesceExpr('title')).toBe('coalesce(n.displayName, n.title)')
        expect(nameCoalesceExpr('  fullName ')).toBe('coalesce(n.displayName, n.fullName)')
    })
})


describe('isInherited', () => {
    it('is true only for a scope ABOVE the data source', () => {
        expect(isInherited('provider')).toBe(true)
        expect(isInherited('workspace')).toBe(true)
        expect(isInherited('global')).toBe(true)
    })
    it('is false when this source set it, or when nothing did', () => {
        // Both mean "there is nothing to inherit FROM to name in the UI":
        // data_source is the local override, default is the code floor.
        expect(isInherited('data_source')).toBe(false)
        expect(isInherited('default')).toBe(false)
        expect(isInherited(undefined)).toBe(false)
    })
})

describe('the inherited-value trap', () => {
    it('a resolved value looks identical to a locally-set one', () => {
        // The API returns the mapping in FORCE, so a source inheriting `id`
        // from its provider is indistinguishable from one that chose `id`
        // itself by value alone. Only the provenance separates them -- which is
        // why any editor seeding from the resolved value must consult it, or it
        // will save an inherited value back as a permanent local override.
        const inherited = { identityProperty: 'id', identityPropertySource: 'provider' as const }
        const local = { identityProperty: 'id', identityPropertySource: 'data_source' as const }
        expect(inherited.identityProperty).toBe(local.identityProperty)
        expect(isIdentityOverridden(inherited.identityProperty)).toBe(true)
        expect(isInherited(inherited.identityPropertySource)).toBe(true)
        expect(isInherited(local.identityPropertySource)).toBe(false)
    })
})
