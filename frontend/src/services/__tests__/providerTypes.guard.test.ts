/**
 * There is no OpenAPI client and no zod for `GET /admin/providers/types` —
 * `providerService`'s `request<T>` merely casts `res.json()`. These pin the
 * hand-written runtime guard that stands in for one: a malformed row is
 * dropped (and logged) rather than crashing the caller or rendering
 * garbage, and a non-array response never throws.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fixture from '../__fixtures__/providerTypes.backend.json'
import { parseProviderTypeList } from '../providerTypes'

const GOOD_ROW = {
    id: 'neo4j',
    label: 'Neo4j',
    description: 'Neo4j graph database via the official Bolt driver.',
    docsUrl: null,
    family: 'cypher',
    capabilities: { writable: true, fullCrud: false, isExternal: false, supportsCopy: false, features: ['multi_graph', 'schema_discovery'] },
    connectionShape: {
        kind: 'generic',
        usesHostPort: true,
        defaultPort: 7687,
        tls: 'flag',
        auth: 'basic',
        databaseField: null,
        fields: [],
        secretCredentialKeys: [],
        extraConfigKeys: ['schemaMapping'],
    },
    adminVisible: true,
}

describe('parseProviderTypeList', () => {
    afterEach(() => vi.restoreAllMocks())

    it('accepts the real backend fixture verbatim', () => {
        expect(parseProviderTypeList(fixture)).toEqual(fixture)
    })

    it('drops a row missing connectionShape, with exactly one console warning, keeping the good rows', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { connectionShape: _dropped, ...rowMissingShape } = GOOD_ROW

        const result = parseProviderTypeList([GOOD_ROW, rowMissingShape])

        expect(result).toEqual([GOOD_ROW])
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('tolerates an unknown family and an unknown feature string rather than dropping the row', () => {
        const withUnknowns = {
            ...GOOD_ROW,
            family: 'quantum',
            capabilities: { ...GOOD_ROW.capabilities, features: ['warp_drive'] },
        }
        const [parsed] = parseProviderTypeList([withUnknowns])
        expect(parsed.family).toBe('quantum')
        expect(parsed.capabilities.features).toEqual(['warp_drive'])
    })

    it.each([null, undefined, {}, 'not an array', 42, true])('returns [] for a non-array input (%j)', input => {
        expect(parseProviderTypeList(input)).toEqual([])
    })

    it('never throws on deeply malformed garbage', () => {
        expect(() => parseProviderTypeList([null, 1, 'x', [], { connectionShape: 'nope' }, GOOD_ROW])).not.toThrow()
        expect(parseProviderTypeList([null, 1, 'x', [], { connectionShape: 'nope' }, GOOD_ROW])).toEqual([GOOD_ROW])
    })
})
