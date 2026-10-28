import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
    normalizeIdentity, isIdentityOverridden, identityCoalesceExpr,
    normalizeName, isNameOverridden, nameCoalesceExpr, isInherited, boundFieldIds,
    boundName, nameOnSave, identitySourcePhrase, type NamedShape,
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

describe('boundFieldIds', () => {
    it('is the `name` field alone without a mapping, or with the default one', () => {
        expect([...boundFieldIds(null)]).toEqual(['name'])
        expect([...boundFieldIds({ nameProperty: 'name', identityProperty: 'urn' })]).toEqual(['name'])
    })
    it("adds the source's own name and identity properties — the Name input and the urn stand for them", () => {
        expect(boundFieldIds({ nameProperty: 'title', identityProperty: 'id' })).toEqual(new Set(['name', 'title', 'id']))
    })
    it('leaves a field the platform owns offered: a mapping onto one is not bound', () => {
        expect(boundFieldIds({ nameProperty: 'description', identityProperty: 'qualifiedName' })).toEqual(new Set(['name']))
    })
})

/** backend/tests/fixtures/node_identity/name_binding.json — the server's rule runs the same cases
 *  (test_node_identity_write_binding.py), so the editor never says a save does what it won't. */
interface NameCase {
    name: string
    mapping: { nameProperty: string }
    minted: boolean
    prior: NamedShape | null
    value: NamedShape
    expect: { displayName: unknown; name: unknown }
}
const CORPUS = join(resolve(__dirname, '../../../..'), 'backend/tests/fixtures/node_identity/name_binding.json')
const NAME_CASES: NameCase[] = JSON.parse(readFileSync(CORPUS, 'utf-8')).cases

describe('boundName — what a save stores, as the server decides it', () => {
    it.each(NAME_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const out = boundName(c.prior, c.value, c.mapping, c.minted)
            ?? { displayName: c.value.displayName, name: c.value.properties?.[c.mapping.nameProperty] }
        expect(out.displayName).toEqual(c.expect.displayName)
        expect(out.name ?? null).toEqual(c.expect.name)
    })

    it('says nothing while the mapping is unknown — the server binds nothing then either', () => {
        expect(boundName(null, { displayName: 'Orders' }, null, true)).toBeNull()
    })
})

describe('nameOnSave', () => {
    const title = { nameProperty: 'title' }
    it('a rename carries the name property while the two agree', () => {
        expect(nameOnSave({ displayName: 'Orders', properties: { title: 'Orders' } },
            { displayName: 'Sales', properties: { title: 'Orders' } }, title))
            .toEqual({ kind: 'follows', property: 'title', from: 'Orders', to: 'Sales' })
    })
    it('a new entity, or one without the property, gets it filled', () => {
        expect(nameOnSave(null, { displayName: 'Orders' }, title, true))
            .toEqual({ kind: 'follows', property: 'title', from: undefined, to: 'Orders' })
    })
    it('editing the name property renames the entity while the two agree', () => {
        expect(nameOnSave({ displayName: 'Orders', properties: { title: 'Orders' } },
            { displayName: 'Orders', properties: { title: 'Sales' } }, title))
            .toEqual({ kind: 'renames', property: 'title', to: 'Sales' })
    })
    it('the two in step stay so', () => {
        const node = { displayName: 'Orders', properties: { title: 'Orders' } }
        expect(nameOnSave(node, node, title)).toEqual({ kind: 'same', property: 'title' })
    })
    it('a name kept apart stays apart — through a rename, or set apart by this edit', () => {
        const prior = { displayName: 'Orders', properties: { title: 'ord' } }
        expect(nameOnSave(prior, prior, title))
            .toEqual({ kind: 'apart', property: 'title', value: 'ord', renamed: false, edited: false })
        expect(nameOnSave(prior, { displayName: 'Sales', properties: { title: 'ord' } }, title))
            .toEqual({ kind: 'apart', property: 'title', value: 'ord', renamed: true, edited: false })
        expect(nameOnSave({ displayName: 'Orders', properties: { title: 'Orders' } },
            { displayName: 'Sales', properties: { title: 'ORD' } }, title))
            .toEqual({ kind: 'apart', property: 'title', value: 'ORD', renamed: true, edited: true })
    })
})

describe('identitySourcePhrase', () => {
    it('says where each setting comes from, and nothing when that is unknown', () => {
        expect(identitySourcePhrase('data_source')).toBe('set on this data source')
        expect(identitySourcePhrase('provider')).toBe('from the provider')
        expect(identitySourcePhrase('workspace')).toBe('from the workspace')
        expect(identitySourcePhrase('global')).toBe('platform default')
        expect(identitySourcePhrase('default')).toBe('built-in default')
        expect(identitySourcePhrase(undefined)).toBe('')
    })
})
