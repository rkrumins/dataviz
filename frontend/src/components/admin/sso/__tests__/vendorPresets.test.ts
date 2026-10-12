/**
 * A preset that teaches the wrong claim names is worse than no preset.
 *
 * These ship as authoritative — the operator sees "Microsoft Entra ID" and
 * reasonably assumes we know what Entra sends. If a preset's own worked
 * example does not resolve through its own mapping, the wizard's live
 * preview shows empty fields on the happy path and the operator concludes
 * their IdP is misconfigured. So the examples are checked against the
 * mappings, mechanically, for every vendor.
 */
import { describe, expect, it } from 'vitest'
import {
    VENDOR_PRESETS, consoleValues, presetById,
} from '../vendorPresets'

/** The resolution rule ``apply_claim_mapping`` uses: first non-empty
 *  candidate wins. Kept deliberately dumb so it mirrors the backend
 *  rather than being clever about it. */
function resolve(
    claims: Record<string, unknown>, candidates: string[],
): unknown {
    for (const path of candidates) {
        const direct = claims[path]
        if (direct !== undefined && direct !== null && direct !== '') return direct
        // one level of dotted nesting, as the backend supports
        if (path.includes('.')) {
            const [head, ...rest] = path.split('.')
            const parent = claims[head]
            if (parent && typeof parent === 'object') {
                const v = (parent as Record<string, unknown>)[rest.join('.')]
                if (v !== undefined && v !== null && v !== '') return v
            }
        }
    }
    return undefined
}

describe.each(VENDOR_PRESETS.map(p => [p.name, p] as const))(
    'preset: %s', (_name, preset) => {

    it('resolves an external_id from its own example', () => {
        // The durable join key. Without it the backend refuses the login
        // outright, so a preset that cannot produce one is broken.
        expect(resolve(preset.sampleClaims, preset.claimMapping.external_id))
            .toBeTruthy()
    })

    it('resolves an email from its own example', () => {
        // The other field the backend will not proceed without.
        expect(resolve(preset.sampleClaims, preset.claimMapping.email))
            .toBeTruthy()
    })

    it('resolves a first and last name from its own example', () => {
        // Not fatal to a login, but a directory full of blank names is how
        // an operator finds out the mapping was wrong — long afterwards.
        expect(resolve(preset.sampleClaims, preset.claimMapping.first_name ?? []))
            .toBeTruthy()
        expect(resolve(preset.sampleClaims, preset.claimMapping.last_name ?? []))
            .toBeTruthy()
    })

    it('declares a kind the backend accepts', () => {
        // Mirrors ``VALID_KINDS`` in ``idp_provider_repo`` and the
        // ``ck_idp_providers_kind`` CHECK. A preset naming a kind the
        // backend does not have fails at INSERT, after the operator has
        // filled in the whole wizard.
        expect(['oidc', 'saml2', 'custom_profile', 'custom', 'backchannel'])
            .toContain(preset.kind)
    })

    it('tells the operator what to do in their own console', () => {
        expect(preset.consoleSteps.length).toBeGreaterThan(0)
        for (const step of preset.consoleSteps) {
            expect(step.title.trim()).not.toBe('')
        }
    })
})

describe('the preset set', () => {
    it('has unique ids', () => {
        const ids = VENDOR_PRESETS.map(p => p.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('covers every kind the backend supports', () => {
        // If a kind exists with no way to pick it, the wizard cannot
        // configure it and the operator falls back to raw JSON.
        const kinds = new Set(VENDOR_PRESETS.map(p => p.kind))
        expect(kinds).toContain('oidc')
        expect(kinds).toContain('saml2')
        expect(kinds).toContain('custom_profile')
    })

    it('offers a generic escape hatch for both standards', () => {
        // Nobody should be stuck because their vendor is not on the grid.
        expect(presetById('oidc')).toBeTruthy()
        expect(presetById('saml2')).toBeTruthy()
    })

    it('orders the grid deterministically', () => {
        const weights = VENDOR_PRESETS.map(p => p.weight)
        expect([...weights].sort((a, b) => a - b)).toEqual(weights)
    })

    it('never claims groups it cannot deliver', () => {
        // Google genuinely omits groups from the ID token. Claiming a
        // mapping there would send operators hunting for a claim their
        // IdP will never send.
        const google = presetById('google')!
        expect(google.claimMapping.groups).toEqual([])
    })
})

describe('console values', () => {
    it('builds the URLs the operator pastes into their IdP', () => {
        const v = consoleValues('entra-staff', 'https://app.corp.example')
        expect(v.redirectUri).toBe(
            'https://app.corp.example/api/v1/auth/entra-staff/callback')
        expect(v.acsUrl).toBe(
            'https://app.corp.example/api/v1/auth/entra-staff/acs')
        expect(v.metadataUrl).toBe(
            'https://app.corp.example/api/v1/auth/entra-staff/metadata')
    })

    it('shows a placeholder before the slug is chosen', () => {
        // The connect step renders these while the operator is still
        // typing a name; a bare "//callback" would look broken.
        expect(consoleValues('', 'https://app.corp.example').redirectUri)
            .toContain('<slug>')
    })

    it('escapes a slug so the URL cannot be broken by one', () => {
        expect(consoleValues('a b', 'https://x').redirectUri).toContain('a%20b')
    })
})
