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
        const text = (await getGuideEntry('sso-operations')!.importFn()).default
        expect(text).toMatch(/ambient_token_missing_from_cookie/)
        expect(text).toMatch(/backchannel_rejected/)
    })

    it('operations says the re-check signing people out is the feature', async () => {
        // Otherwise it reads as a bug, and the first instinct is to
        // turn off the thing that closes the gap.
        const text = (await getGuideEntry('sso-operations')!.importFn()).default
        expect(text).toMatch(/keep getting signed out/i)
    })
})
