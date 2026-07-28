/**
 * The two shapes the server refuses outright.
 *
 * Both are knowable before the click, and both used to arrive as a 400 with
 * a paragraph of server prose after the rule had been fully composed. The
 * risk in moving a check client-side is over-blocking, so the "ordinary
 * role is unaffected" case is asserted as hard as the refusals: a
 * low-assurance connection mapping to a workspace role is a legitimate
 * configuration, and refusing it would be a worse bug than the one this
 * fixes.
 */
import { describe, expect, it } from 'vitest'
import { privilegedRuleBlock, isPlatformAdminRole } from '../privilegedRule'
import type { IdpProvider } from '@/services/ssoAdminService'

function provider(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
        assurance: 'verified',
        ...over,
    } as IdpProvider
}

const VERIFIED = provider()
const UNVERIFIED = provider({
    id: 'idp_2', slug: 'portal', displayName: 'Corporate portal',
    assurance: 'unverified',
})

describe('which roles are privileged', () => {
    it('recognises the platform tier', () => {
        expect(isPlatformAdminRole('org_admin')).toBe(true)
    })

    it('leaves ordinary roles alone', () => {
        expect(isPlatformAdminRole('workspace_editor')).toBe(false)
        expect(isPlatformAdminRole('org_member')).toBe(false)
    })
})

describe('an ordinary role is never blocked', () => {
    it('not even from an unverified connection', () => {
        // The whole point of the assurance gate is that it applies to
        // platform admin only. Over-blocking here would break a legitimate
        // and common configuration.
        expect(privilegedRuleBlock('workspace_editor', 'idp_2', [VERIFIED, UNVERIFIED]))
            .toBeNull()
    })

    it('not even from any connection at all', () => {
        expect(privilegedRuleBlock('org_member', '', [UNVERIFIED])).toBeNull()
    })

    it('and an empty role is not a block, just an unfinished rule', () => {
        expect(privilegedRuleBlock('', '', [VERIFIED])).toBeNull()
    })
})

describe('a platform-admin role needs one named connection', () => {
    it('is refused against "any connection"', () => {
        const block = privilegedRuleBlock('org_admin', '', [VERIFIED])
        expect(block?.message).toMatch(/one named connection/i)
        // The reason, not just the rule: a wildcard would cover an
        // unverified connection added later.
        expect(block?.message).toMatch(/unverified one added later/i)
    })

    it('names the single verified connection that would work', () => {
        expect(privilegedRuleBlock('org_admin', '', [VERIFIED, UNVERIFIED])?.suggestion)
            .toMatch(/Corporate Entra/)
    })

    it('counts them when there is more than one to choose from', () => {
        const two = [VERIFIED, provider({ id: 'idp_3', slug: 'okta' })]
        expect(privilegedRuleBlock('org_admin', '', two)?.suggestion)
            .toMatch(/2 verified/)
    })

    it('says so plainly when nothing is verified', () => {
        expect(privilegedRuleBlock('org_admin', '', [UNVERIFIED])?.suggestion)
            .toMatch(/no connection is verified/i)
    })
})

describe('a platform-admin role needs a verified connection', () => {
    it('is refused from an unverified one, and says which', () => {
        const block = privilegedRuleBlock('org_admin', 'idp_2', [VERIFIED, UNVERIFIED])
        expect(block?.message).toMatch(/Corporate portal is unverified/i)
        expect(block?.suggestion).toMatch(/Corporate Entra is verified/i)
    })

    it('is allowed from a verified one', () => {
        expect(privilegedRuleBlock('org_admin', 'idp_1', [VERIFIED, UNVERIFIED]))
            .toBeNull()
    })

    it('is refused from an asserted one — asserted is not verified', () => {
        // The middle level is the easy one to get wrong: a trusted proxy
        // vouching for someone is not a signature over their assertion.
        const asserted = provider({ id: 'idp_4', assurance: 'asserted' })
        expect(privilegedRuleBlock('org_admin', 'idp_4', [asserted])).toBeTruthy()
    })
})
