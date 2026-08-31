import { describe, it, expect } from 'vitest'
import fixture from '../__fixtures__/providerTypes.backend.json'
import {
    PROVIDER_TYPE_IDS,
    PROVIDER_VISUALS,
    STATIC_PROVIDER_TYPES,
    isProviderType,
    providerVisual,
    providerLabel,
    providerShortLabel,
    providerTypeEntry,
    shapeKind,
    mergeCatalog,
    supportsFeature,
    defaultPortFor,
    formOwnedExtraKeys,
    type ProviderTypeInfo,
} from '../providerTypes'

describe('PROVIDER_VISUALS', () => {
    it('has an entry for every PROVIDER_TYPE_IDS member', () => {
        for (const id of PROVIDER_TYPE_IDS) {
            expect(PROVIDER_VISUALS[id]).toBeDefined()
        }
    })
})

describe('isProviderType', () => {
    it('accepts every PROVIDER_TYPE_IDS member', () => {
        for (const id of PROVIDER_TYPE_IDS) {
            expect(isProviderType(id)).toBe(true)
        }
    })

    it('rejects a foreign id, a non-string, null and undefined', () => {
        expect(isProviderType('arcadedb')).toBe(false)
        expect(isProviderType(42)).toBe(false)
        expect(isProviderType(null)).toBe(false)
        expect(isProviderType(undefined)).toBe(false)
    })
})

describe('providerVisual / providerLabel / providerShortLabel', () => {
    it('falls back to the unknown visual, labelled with the raw id, for an id outside PROVIDER_TYPE_IDS', () => {
        const visual = providerVisual('nope')
        expect(visual.label).toBe('nope')
        expect(visual).not.toBe(PROVIDER_VISUALS.falkordb)
    })

    it('providerLabel/providerShortLabel are thin reads of PROVIDER_VISUALS', () => {
        expect(providerLabel('falkordb')).toBe(PROVIDER_VISUALS.falkordb.label)
        expect(providerShortLabel('datahub')).toBe(PROVIDER_VISUALS.datahub.shortLabel)
    })

    it('treat null/undefined/empty-string as no id at all (not a foreign id)', () => {
        expect(providerVisual(null).label).toBe('Unknown')
        expect(providerVisual(undefined).label).toBe('Unknown')
        expect(providerVisual('').label).toBe('Unknown')
    })
})

describe('providerTypeEntry', () => {
    it('finds a real id in the static snapshot by default', () => {
        expect(providerTypeEntry('falkordb')).toBe(STATIC_PROVIDER_TYPES.find(t => t.id === 'falkordb'))
    })

    it('prefers a caller-supplied catalog over the static snapshot', () => {
        const liveNeo4j: ProviderTypeInfo = {
            ...STATIC_PROVIDER_TYPES.find(t => t.id === 'neo4j')!,
            description: 'a live row, not the static one',
        }
        const entry = providerTypeEntry('neo4j', [{ ...liveNeo4j, visual: providerVisual('neo4j') }])
        expect(entry.description).toBe('a live row, not the static one')
    })

    it('falls back to the static snapshot when the id is missing from the caller-supplied catalog', () => {
        expect(providerTypeEntry('falkordb', [])).toBe(STATIC_PROVIDER_TYPES.find(t => t.id === 'falkordb'))
    })

    it('synthesizes a generic, feature-less entry for an id found nowhere', () => {
        const entry = providerTypeEntry('arcadedb')
        expect(entry.id).toBe('arcadedb')
        expect(entry.capabilities.features).toEqual([])
        expect(entry.connectionShape.kind).toBe('generic')
    })
})

describe('shapeKind', () => {
    it('reads connectionShape.kind off the resolved entry', () => {
        expect(shapeKind('falkordb')).toBe('falkordb')
        expect(shapeKind('spanner')).toBe('spanner')
        expect(shapeKind('neo4j')).toBe('generic')
    })
})

describe('mergeCatalog', () => {
    it('falls back to STATIC_PROVIDER_TYPES when no catalog data is available', () => {
        expect(mergeCatalog(undefined)).toBe(STATIC_PROVIDER_TYPES)
    })

    it('falls back for an EMPTY array too, not just undefined', () => {
        // `[]` is truthy, so a `!infos` guard let this through as a real
        // answer and every list-iterating surface rendered nothing — the
        // wizard's type cards included. An all-rows-dropped parse is
        // exactly what the offline snapshot exists for; no deployment has
        // zero provider types.
        expect(mergeCatalog([])).toBe(STATIC_PROVIDER_TYPES)
    })

    it('renders a type this bundle does not know about with the unknown visual', () => {
        const arcadedb: ProviderTypeInfo = {
            id: 'arcadedb',
            label: 'ArcadeDB',
            description: 'PR 3.',
            docsUrl: null,
            family: 'gql',
            capabilities: { writable: true, fullCrud: true, isExternal: false, supportsCopy: false, features: [] },
            connectionShape: {
                kind: 'generic',
                usesHostPort: true,
                defaultPort: 2480,
                tls: 'flag',
                auth: 'basic',
                databaseField: null,
                fields: [],
                secretCredentialKeys: [],
                extraConfigKeys: [],
            },
            adminVisible: true,
        }
        const [entry] = mergeCatalog([arcadedb])
        expect(entry.visual.label).toBe('arcadedb')
        expect(entry.visual).not.toBe(PROVIDER_VISUALS.falkordb)
    })
})

describe('supportsFeature', () => {
    it('is true for a feature the type declares', () => {
        expect(supportsFeature('falkordb', 'blank_models')).toBe(true)
    })

    it('is false for a feature the type does not declare', () => {
        expect(supportsFeature('neo4j', 'blank_models')).toBe(false)
    })
})

describe('defaultPortFor', () => {
    it('is 0 (not null) for a shape with no default port, so callers can keep `port: number`', () => {
        expect(defaultPortFor('spanner')).toBe(0)
    })
})

describe('formOwnedExtraKeys', () => {
    it('is schemaMapping plus the falkordb shape\'s own extra-config keys', () => {
        const falkordb = STATIC_PROVIDER_TYPES.find(t => t.id === 'falkordb')!
        expect(formOwnedExtraKeys(falkordb)).toEqual(new Set(['schemaMapping', 'falkordbConnection', 'cacheConnection']))
    })
})

describe('STATIC_PROVIDER_TYPES pinned to the backend fixture', () => {
    it('agrees with __fixtures__/providerTypes.backend.json for every backend-sourced row', () => {
        // STATIC_PROVIDER_TYPES also carries a synthetic `mock` entry (never
        // registered in the backend catalog — see providerTypes.ts) and each
        // row's frontend-only `visual`; strip both before comparing so this
        // pins exactly what the fixture generator asserts: the frontend's
        // offline assumptions about the SERVER'S rows agree with what T-G's
        // backend test captured, byte for byte.
        const backendSourced = STATIC_PROVIDER_TYPES
            .filter(t => t.id !== 'mock')
            .map(({ visual: _visual, ...info }) => info)
        expect(backendSourced).toEqual(fixture)
    })

    it('every fixture row id is one PROVIDER_TYPE_IDS already knows', () => {
        for (const row of fixture as ProviderTypeInfo[]) {
            expect(PROVIDER_TYPE_IDS as readonly string[]).toContain(row.id)
        }
    })
})
