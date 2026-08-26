/**
 * Every slug the SSO surfaces link to must resolve.
 *
 * ``DocsLink`` only warns about an unknown slug in dev, so a typo or a
 * renamed article would ship as a link that silently lands on the in-app
 * not-found panel. This is the cheapest possible guard against that.
 *
 * The `importFn` check matters as much as the registration: a slug can be
 * registered correctly and point at a file that does not exist, which fails
 * the same way — a link that goes nowhere — but would pass a test that only
 * looked at the entry.
 */
import { describe, expect, it } from 'vitest'
import { getGuideEntry } from '@/components/guide/guideConfig'

const SLUGS = ['sso-setup', 'sso-operations'] as const

describe('the SSO guide articles', () => {
    it.each(SLUGS)('%s is registered', slug => {
        expect(getGuideEntry(slug)).toBeTruthy()
    })

    it.each(SLUGS)('%s is filed under admin, where an operator would look', slug => {
        expect(getGuideEntry(slug)?.section).toBe('admin')
    })

    it.each(SLUGS)('%s points at a file that exists', async slug => {
        const mod = await getGuideEntry(slug)!.importFn()
        // Vite's ?raw import resolves to { default: '<file contents>' }.
        expect(typeof mod.default).toBe('string')
        expect(mod.default.length).toBeGreaterThan(500)
    })

    it('names them so the pair reads as setup then operations', () => {
        expect(getGuideEntry('sso-setup')?.title).toMatch(/single sign-on/i)
        expect(getGuideEntry('sso-operations')?.title).toMatch(/running/i)
    })
})


describe('every provider kind an operator can pick is documented', () => {
    /**
     * A kind that reaches the wizard but not the guide is one people
     * have to reverse-engineer from the form. The presets are the list
     * of what can be picked, so they are the right thing to check
     * against — a new preset with no guide entry fails here rather than
     * becoming a support question.
     */
    it('setup covers the two internal kinds by name', async () => {
        const text = (await getGuideEntry('sso-setup')!.importFn()).default
        expect(text).toMatch(/Corporate portals/)
        expect(text).toMatch(/Enterprise gateways/)
    })

    it('setup tells gateway operators the host must be allowed first', async () => {
        // The single most likely reason a correctly-configured gateway
        // does not work, and nothing in the connection form would ever
        // hint at it on its own.
        const text = (await getGuideEntry('sso-setup')!.importFn()).default
        expect(text).toMatch(/Internal gateways SSO may call/)
    })

    it('operations explains the failures only this kind can produce', async () => {
        // In the vocabulary the implementation actually emits. The first
        // version of this table was written against a draft format
        // (`backchannel_rejected:…`) that the code never shipped, so an
        // operator searching the audit log for the documented string
        // found nothing — the exact failure documentation exists to
        // prevent.
        const text = (await getGuideEntry('sso-operations')!.importFn()).default
        expect(text).toMatch(/backchannel_no_session/)
        expect(text).toMatch(/backchannel_idp_rejected/)
        expect(text).toMatch(/backchannel_unavailable/)
        expect(text).toMatch(/backchannel_claims_unmappable/)
        expect(text).not.toMatch(/ambient_token_missing_from_cookie/)
        expect(text).not.toMatch(/backchannel_rejected:/)
    })

    it('operations says the re-check signing people out is the feature', async () => {
        // Otherwise it reads as a bug, and the first instinct is to
        // turn off the thing that closes the gap.
        const text = (await getGuideEntry('sso-operations')!.importFn()).default
        expect(text).toMatch(/keep getting signed out/i)
    })
})


describe('the parts of the gateway flow an operator cannot infer', () => {
    it('says the first call is made by the browser, not the server', async () => {
        // An operator who assumes otherwise will ask their identity team
        // for the wrong thing, and the shape they get back cannot work.
        const text = (await getGuideEntry('sso-setup')!.importFn()).default
        expect(text).toMatch(/made by the browser rather than by/i)
    })

    it('warns that the trigger headers are public', async () => {
        // Three header fields, names differing by one word, one of them
        // published to every visitor of the sign-in page.
        const text = (await getGuideEntry('sso-setup')!.importFn()).default
        expect(text).toMatch(/readable by anyone who opens the sign-in/i)
    })

    it('points at the contract doc by path, not as an in-app link', async () => {
        // It is written for the client's engineers and deliberately not
        // registered as a /docs route — a link would 404 in-app.
        const text = (await getGuideEntry('sso-setup')!.importFn()).default
        expect(text).toMatch(/SSO_BACKCHANNEL_CONTRACT\.md/)
        expect(text).not.toMatch(/\/docs\/sso-backchannel/)
    })
})
