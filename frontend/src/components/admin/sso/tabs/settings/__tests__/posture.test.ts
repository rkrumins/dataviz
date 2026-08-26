/**
 * What the four switches add up to.
 *
 * The combinations are the point. Any single switch is easy to describe
 * and the page always did; what it never said was what they mean
 * *together* — and the dangerous state is one no single row can warn
 * about, because it only exists when two of them agree.
 */
import { describe, expect, it } from 'vitest'
import { describePosture, riskChecks } from '../posture'
import type { AuthConfig, IdpProvider } from '@/services/ssoAdminService'

function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
    return {
        ssoEnabled: true, allowLocalLogin: true,
        allowJitProvisioning: true, emailFirstLogin: false,
        version: 1, updatedAt: new Date().toISOString(),
        ...over,
    }
}

function provider(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
        kind: 'oidc', enabled: true, priority: 100, settings: {},
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'verified', assuranceReason: '',
        emailDomains: [], lifecycle: 'live',
        createdAt: '', updatedAt: '',
        ...over,
    } as IdpProvider
}

describe('the combination nobody can see from one row', () => {
    it('calls out that both doors are shut', () => {
        // The server refuses this combination whether it arrives in one
        // PATCH or two — but the state can exist anyway (a seed, a direct
        // DB edit), so the page still has to be able to say it.
        const p = describePosture(
            cfg({ ssoEnabled: false, allowLocalLogin: false }), [provider()],
        )
        expect(p.tone).toBe('danger')
        expect(p.headline).toMatch(/nobody can sign in/i)
        expect(p.notes.join(' ')).toMatch(/existing sessions keep working/i)
    })

    it('does not cry danger when one door is open', () => {
        expect(describePosture(cfg({ ssoEnabled: false }), [provider()]).tone)
            .toBe('warn')
        expect(describePosture(cfg({ allowLocalLogin: false }), [provider()]).tone)
            .toBe('ok')
    })

    it('says that sessions outlive the master switch', () => {
        // The switch stops new sign-ins; it does not end the sessions the
        // connections already minted. The posture card has to say so, or
        // "SSO is off" reads as more than it is.
        const p = describePosture(cfg({ ssoEnabled: false }), [provider()])
        expect(p.notes.join(' '))
            .toMatch(/stay signed in until their sessions expire/i)
    })
})

describe('what a person actually sees', () => {
    it('names the live connections', () => {
        const p = describePosture(cfg(), [provider()])
        expect(p.headline).toContain('Corporate Entra')
        expect(p.tone).toBe('ok')
    })

    it('counts buttons rather than listing five of them', () => {
        const many = ['a', 'b', 'c', 'd'].map((s, i) =>
            provider({ id: `idp_${i}`, slug: s, displayName: s.toUpperCase() }))
        expect(describePosture(cfg(), many).headline).toMatch(/and 2 more/)
    })

    it('describes email-first as a routed question, not a row of buttons', () => {
        const p = describePosture(cfg({ emailFirstLogin: true }), [provider()])
        expect(p.headline).toMatch(/asked for their email/i)
    })

    it('treats a draft as not live, because nobody can see it', () => {
        const p = describePosture(cfg(), [provider({ lifecycle: 'draft' })])
        expect(p.headline).toMatch(/no connection is live/i)
        expect(p.notes.join(' ')).toMatch(/publishing a draft/i)
    })

    it('treats a disabled connection as not live either', () => {
        const p = describePosture(cfg(), [provider({ enabled: false })])
        expect(p.headline).toMatch(/no connection is live/i)
    })

    it('says whether a newcomer gets an account', () => {
        expect(describePosture(cfg(), [provider()]).notes.join(' '))
            .toMatch(/gets an account automatically/i)
        expect(describePosture(cfg({ allowJitProvisioning: false }), [provider()])
            .notes.join(' ')).toMatch(/no account is created automatically/i)
    })
})

describe('risks that only the world can tell you', () => {
    it('flags email-first with nowhere to route', () => {
        // The server cannot refuse this — an unroutable configuration is
        // valid, just useless — so it is the one check that has to be here.
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [provider()])
        const r = risks.find(x => x.field === 'emailFirstLogin')
        expect(r?.tone).toBe('danger')
        expect(r?.message).toMatch(/no address can route anywhere/i)
    })

    it('names the connections nobody can reach by email', () => {
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [
            provider({ id: 'a', displayName: 'Entra', emailDomains: ['corp.example'] }),
            provider({ id: 'b', displayName: 'Okta Contractors' }),
        ])
        const r = risks.find(x => x.field === 'emailFirstLogin')
        expect(r?.tone).toBe('warn')
        expect(r?.message).toContain('Okta Contractors')
    })

    it('is quiet when every live connection can be routed to', () => {
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [
            provider({ emailDomains: ['corp.example'] }),
        ])
        expect(risks.find(x => x.field === 'emailFirstLogin')).toBeUndefined()
    })

    it('warns that SSO is the only way in when passwords are off', () => {
        const r = riskChecks(cfg({ allowLocalLogin: false }), [provider()])
            .find(x => x.field === 'ssoEnabled')
        expect(r?.tone).toBe('danger')
        expect(r?.message).toMatch(/locks everyone out/i)
    })

    it('sets the expectation that turning passwords off can be refused', () => {
        // Turning a 409 into something the operator already knew.
        const r = riskChecks(cfg(), [provider()])
            .find(x => x.field === 'allowLocalLogin')
        expect(r?.message).toMatch(/refused if any active admin/i)
    })
})
