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
