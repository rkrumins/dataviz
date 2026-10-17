/**
 * What the four switches add up to.
 *
 * The combinations are the point. Any single switch is easy to describe
 * and the page always did; what it never said was what they mean
 * *together* — and the dangerous state is one no single row can warn
 * about, because it only exists when two of them agree.
 */
import { describe, expect, it } from 'vitest'
import { describePosture, primaryConnection, riskChecks } from '../posture'
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

    it('names two and counts the rest rather than listing all of them', () => {
        const many = ['a', 'b', 'c', 'd'].map((s, i) =>
            provider({ id: `idp_${i}`, slug: s, displayName: s.toUpperCase() }))
        expect(describePosture(cfg(), many).headline).toMatch(/and 2 more/)
    })

    it('describes email-first as a routed question, not a row of buttons', () => {
        const p = describePosture(cfg({ emailFirstLogin: true }), [provider()])
        expect(p.headline).toMatch(/asked for their email/i)
    })

    it('leads with single sign-on and puts the password behind it', () => {
        expect(describePosture(cfg(), [provider()]).headline).toBe(
            'People continue with Corporate Entra, or type their email. '
            + 'Anyone can fall back to a password.',
        )
        expect(describePosture(cfg({ allowLocalLogin: false }), [provider()]).headline)
            .toMatch(/passwords are off — break-glass accounts only/i)
    })

    it('says the emergency window is open while it is, and not after', () => {
        const now = Date.parse('2026-10-13T12:00:00Z')
        const open = cfg({
            allowLocalLogin: false,
            passwordFallbackUntil: '2026-10-13T13:00:00Z',
        })
        expect(describePosture(open, [provider()], now).headline)
            .toMatch(/anyone can use a password while emergency access is open/i)
        // It closes by itself — the sentence follows the clock, not a refetch.
        expect(describePosture(open, [provider()], now + 2 * 3600_000).headline)
            .toMatch(/break-glass accounts only/i)
    })

    it('says where an unmatched address goes once there is a choice', () => {
        const two = [
            provider({ id: 'a', slug: 'entra' }),
            provider({ id: 'b', slug: 'okta', displayName: 'Okta' }),
        ]
        expect(describePosture(cfg(), two).notes.join(' '))
            .toMatch(/matches no email domain goes to Corporate Entra, the primary/i)
        // With one connection there is nowhere else to go — nothing to say.
        expect(describePosture(cfg(), [provider()]).notes.join(' '))
            .not.toMatch(/primary/i)
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
    it('needs no domains for the primary — unmatched addresses go there', () => {
        // An address matching nothing used to fall through to the password
        // form; now it goes to the primary, so one connection with no
        // domains is a complete configuration.
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [provider()])
        expect(risks.find(x => x.field === 'emailFirstLogin')).toBeUndefined()
    })

    it('names the connections nobody can reach by email', () => {
        // The server cannot refuse this — a lopsided routing is valid,
        // just unhelpful — so it is the one check that has to be here.
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [
            provider({ id: 'a', displayName: 'Entra', emailDomains: ['corp.example'] }),
            provider({ id: 'b', displayName: 'Okta Contractors' }),
        ])
        const r = risks.find(x => x.field === 'emailFirstLogin')
        expect(r?.tone).toBe('warn')
        expect(r?.message).toContain('Okta Contractors')
        expect(r?.message).not.toContain('Entra')
    })

    it('counts the primary as reachable even without domains', () => {
        const risks = riskChecks(cfg({ emailFirstLogin: true }), [
            provider({ id: 'a', displayName: 'Entra' }),
            provider({ id: 'b', displayName: 'Okta Contractors' }),
        ])
        expect(risks.find(x => x.field === 'emailFirstLogin')?.message)
            .toMatch(/^Okta Contractors has no email domains/)
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

    it('sets the expectation of what turning passwords off asks for', () => {
        // Turning a 409 into something the operator already knew.
        const r = riskChecks(cfg(), [provider()])
            .find(x => x.field === 'allowLocalLogin')
        expect(r?.tone).toBe('warn')
        expect(r?.message).toMatch(/lists any super admin with no sso identity/i)
        // The carve-out is part of the expectation: a system account
        // neither blocks the switch nor is locked out by it.
        expect(r?.message).toMatch(/system account/i)
    })

    it('says before the click that it will be refused with nobody ready', () => {
        const r = riskChecks(
            cfg({ breakGlass: { ready: false, accounts: [] } }), [provider()],
        ).find(x => x.field === 'allowLocalLogin')
        expect(r?.tone).toBe('danger')
        expect(r?.message).toMatch(/no break-glass account is ready/i)
        expect(r?.message).toMatch(/refused/i)
    })
})

describe('the way back in when the IdP is not there', () => {
    const notReady = { breakGlass: { ready: false, accounts: [] } }

    it('turns the posture red once passwords are off with nobody ready', () => {
        const p = describePosture(
            cfg({ allowLocalLogin: false, ...notReady }), [provider()],
        )
        expect(p.tone).toBe('danger')
        expect(p.notes[0]).toMatch(
            /no break-glass account is ready — an idp outage could lock everyone out/i,
        )
    })

    it('stays calm while passwords are on — everyone still has a way in', () => {
        const p = describePosture(cfg(notReady), [provider()])
        expect(p.tone).toBe('ok')
        expect(p.notes.join(' ')).not.toMatch(/break-glass/i)
    })

    it('stays calm when a break-glass account is ready', () => {
        const p = describePosture(cfg({
            allowLocalLogin: false,
            breakGlass: { ready: true, accounts: [] },
        }), [provider()])
        expect(p.tone).toBe('ok')
    })
})

describe('the primary connection', () => {
    it('is the first live one, in the order the server listed them', () => {
        expect(primaryConnection([
            provider({ id: 'draft', lifecycle: 'draft' }),
            provider({ id: 'off', enabled: false }),
            provider({ id: 'first' }),
            provider({ id: 'second' }),
        ])?.id).toBe('first')
    })

    it('skips what an address cannot be routed to', () => {
        // The dev kind, and a portal whose payload only the browser can
        // read — neither can take a redirect for a typed address.
        expect(primaryConnection([
            provider({ id: 'dev', kind: 'custom' }),
            provider({ id: 'ls', kind: 'custom_profile', settings: { source: 'local_storage' } }),
            provider({ id: 'ss', kind: 'custom_profile', settings: { source: 'session_storage' } }),
            provider({ id: 'cookie', kind: 'custom_profile', settings: { source: 'cookie' } }),
        ])?.id).toBe('cookie')
        expect(primaryConnection([provider({ kind: 'custom' })])).toBeNull()
    })
})
