/**
 * Pins the catalog itself. Today, before this module existed, NO frontend
 * test asserted the type list or card count — a new type would have
 * silently rendered with the FalkorDB logo/tint. This file is the guard
 * against that regressing, and against `STATIC_PROVIDER_TYPES` drifting
 * from `__fixtures__/providerTypes.backend.json`.
 *
 * That is one half of a two-part chain, and the half that can be checked
 * from here: this file cannot see the server. What pins the fixture itself
 * to the live `GET /admin/providers/types` response is the backend test that
 * writes it — `test_api_provider_types.py::
 * test_list_provider_types_generates_the_frontend_fixture`, which compares
 * file against response on every run where it is not regenerating. Read this
 * file alone and the assertion below is a parser round-trip; read both and
 * `STATIC_PROVIDER_TYPES` is pinned to what the server sends.
 */
import { describe, it, expect } from 'vitest'
import fixture from '../__fixtures__/providerTypes.backend.json'
import { FalkorDBLogo } from '@/components/admin/ProviderLogos'
import {
    PROVIDER_TYPE_IDS,
    PROVIDER_VISUALS,
    STATIC_PROVIDER_TYPES,
    providerTypeEntry,
    providerVisual,
    type ProviderTypeInfo,
} from '../providerTypes'

describe('STATIC_PROVIDER_TYPES pinned to the backend fixture', () => {
    it('deep-equals __fixtures__/providerTypes.backend.json for every backend-sourced row', () => {
        // See providerTypes.test.ts for why `visual` and the synthetic
        // `mock` row are stripped before comparing.
        const backendSourced = STATIC_PROVIDER_TYPES
            .filter(t => t.id !== 'mock')
            .map(({ visual: _visual, ...info }) => info)
        expect(backendSourced).toEqual(fixture)
    })

    it('every backend row id is one PROVIDER_TYPE_IDS already knows — else the bundle is stale', () => {
        // PR 3 will hit this deliberately the day the backend starts
        // serving 'arcadedb' before the frontend bundle has shipped it.
        for (const row of fixture as ProviderTypeInfo[]) {
            expect(PROVIDER_TYPE_IDS as readonly string[]).toContain(row.id)
        }
    })
})

describe('every PROVIDER_TYPE_IDS member is fully registered', () => {
    for (const id of PROVIDER_TYPE_IDS) {
        it(`${id} has a complete PROVIDER_VISUALS entry and a well-shaped catalog row`, () => {
            const visual = PROVIDER_VISUALS[id]
            expect(visual.Logo).toBeTruthy()
            expect(visual.label.length).toBeGreaterThan(0)
            expect(visual.shortLabel.length).toBeGreaterThan(0)
            expect(typeof visual.desc).toBe('string')

            const entry = providerTypeEntry(id)
            expect(['generic', 'falkordb', 'spanner']).toContain(entry.connectionShape.kind)
            expect(
                entry.connectionShape.defaultPort === null || typeof entry.connectionShape.defaultPort === 'number',
            ).toBe(true)
        })
    }

    it('no non-falkordb id renders with the FalkorDB logo', () => {
        for (const id of PROVIDER_TYPE_IDS) {
            if (id === 'falkordb') continue
            expect(providerVisual(id).Logo).not.toBe(FalkorDBLogo)
        }
    })
})

describe('providerVisual on a foreign id', () => {
    it('labels it with the raw id and uses the neutral (non-FalkorDB) icon', () => {
        const visual = providerVisual('nope')
        expect(visual.label).toBe('nope')
        expect(visual.Logo).not.toBe(FalkorDBLogo)
    })
})
