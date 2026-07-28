/**
 * The wizard and the first-run hero both point at ``sso-setup``.
 *
 * ``DocsLink`` only warns about an unknown slug in dev, so a typo or a
 * renamed article would ship as a link that silently lands on the in-app
 * not-found panel. This is the cheapest possible guard against that.
 */
import { describe, expect, it } from 'vitest'
import { getGuideEntry } from '@/components/guide/guideConfig'

describe('the SSO guide article', () => {
    it('is registered under the slug the SSO surfaces link to', () => {
        const entry = getGuideEntry('sso-setup')
        expect(entry).toBeTruthy()
        expect(entry?.title).toMatch(/single sign-on/i)
    })

    it('is filed under admin, where an operator would look for it', () => {
        expect(getGuideEntry('sso-setup')?.section).toBe('admin')
    })
})
