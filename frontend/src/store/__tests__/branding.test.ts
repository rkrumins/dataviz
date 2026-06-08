import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrandingStore, applyBranding, DEFAULT_BRANDING } from '../branding'
import * as svc from '@/services/brandingService'
import type { Branding } from '@/services/brandingService'

function branding(over: Partial<Branding> = {}): Branding {
    return { ...DEFAULT_BRANDING, ...over }
}

describe('branding store', () => {
    beforeEach(() => {
        useBrandingStore.setState({ branding: DEFAULT_BRANDING, loaded: false })
        document.documentElement.style.removeProperty('--nx-accent-lineage')
    })
    afterEach(() => vi.restoreAllMocks())

    it('applies title, favicon and accent on a successful load', async () => {
        vi.spyOn(svc, 'fetchPublicBranding').mockResolvedValueOnce(
            branding({ appName: 'Acme', accentColor: '#ff0000', faviconUrl: '/acme.svg' }),
        )
        await useBrandingStore.getState().loadBranding()

        expect(useBrandingStore.getState().branding.appName).toBe('Acme')
        expect(useBrandingStore.getState().loaded).toBe(true)
        expect(document.title).toBe('Acme')
        expect(document.documentElement.style.getPropertyValue('--nx-accent-lineage')).toBe('#ff0000')
        const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
        expect(link?.getAttribute('href')).toBe('/acme.svg')
    })

    it('keeps the seed defaults when the fetch fails', async () => {
        vi.spyOn(svc, 'fetchPublicBranding').mockResolvedValueOnce(null)
        await useBrandingStore.getState().loadBranding()

        expect(useBrandingStore.getState().branding).toEqual(DEFAULT_BRANDING)
        expect(useBrandingStore.getState().loaded).toBe(true)
        expect(document.title).toBe(DEFAULT_BRANDING.appName)
    })

    it('applyBranding does not clear the accent when given a blank colour', () => {
        document.documentElement.style.setProperty('--nx-accent-lineage', '#123456')
        applyBranding(branding({ accentColor: '' }))
        expect(document.documentElement.style.getPropertyValue('--nx-accent-lineage')).toBe('#123456')
    })

    it('setBranding replaces branding and re-applies side-effects', () => {
        useBrandingStore.getState().setBranding(branding({ appName: 'Beta Corp' }))
        expect(useBrandingStore.getState().branding.appName).toBe('Beta Corp')
        expect(document.title).toBe('Beta Corp')
    })
})
