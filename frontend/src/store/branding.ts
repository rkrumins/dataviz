/**
 * Branding store — white-label app identity, fetched once on boot.
 *
 * Seeded with the stock product defaults so the very first paint (and any
 * deployment where the fetch is slow/unavailable) renders correctly, then
 * reconciled to the served values by ``loadBranding()``. The store also
 * owns the DOM side-effects that can't be expressed in React — the tab
 * title, the favicon ``<link>``, and the accent CSS variable — applied
 * whenever branding changes.
 *
 * Components read identity through ``useBrand()``; the raw strings that
 * used to be hardcoded in TopBar / auth pages / CommandPalette now flow
 * from here, so a single admin change (or env var) updates them all.
 */
import { create } from 'zustand'
import type { Branding } from '@/services/brandingService'
import { fetchPublicBranding } from '@/services/brandingService'

/** Stock defaults — mirror the backend env defaults so first paint matches
 *  an un-rebranded deployment exactly. */
export const DEFAULT_BRANDING: Branding = {
    appName: 'Nexus Lineage',
    shortName: 'NexusLineage',
    description: 'Interactive Data Lineage Visualization',
    logoUrl: '',
    faviconUrl: '/nexus-icon.svg',
    accentColor: '#6366f1',
    copyrightText: '© 2026 Nexus Lineage',
    supportEmail: '',
    loginTagline: 'Sign in to continue',
    version: 0,
    updatedAt: '',
}

interface BrandingState {
    branding: Branding
    loaded: boolean
    /** Fetch the public branding and apply it. Best-effort. */
    loadBranding: () => Promise<void>
    /** Replace branding (e.g. after an admin save) and re-apply side-effects. */
    setBranding: (b: Branding) => void
}

export const useBrandingStore = create<BrandingState>()((set) => ({
    branding: DEFAULT_BRANDING,
    loaded: false,
    loadBranding: async () => {
        const served = await fetchPublicBranding()
        if (served) {
            applyBranding(served)
            set({ branding: served, loaded: true })
        } else {
            // Keep the seed; still apply it so title/favicon/accent are set.
            applyBranding(DEFAULT_BRANDING)
            set({ loaded: true })
        }
    },
    setBranding: (b) => {
        applyBranding(b)
        set({ branding: b })
    },
}))

/** Convenience selector — the live branding object. */
export function useBrand(): Branding {
    return useBrandingStore((s) => s.branding)
}

/**
 * Apply the DOM-level side-effects of branding. Idempotent; safe to call
 * on every change. Lives here (not in a component effect) because the tab
 * title + favicon are document-level singletons and the accent variable
 * must be set on ``:root`` before any component renders against it.
 */
export function applyBranding(b: Branding): void {
    // Tab title — the base; per-page effects prepend their own segment.
    document.title = b.appName

    // Favicon — swap the existing <link rel="icon"> href, or create one.
    if (b.faviconUrl) {
        let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
        if (!link) {
            link = document.createElement('link')
            link.rel = 'icon'
            document.head.appendChild(link)
        }
        link.href = b.faviconUrl
    }

    // Accent colour — drive the primary accent CSS variable the theme
    // already keys off (``--nx-accent-lineage``). Only the primary accent
    // is overridden; the semantic business/technical/warning accents keep
    // their meaning. Guard against a blank value clearing the default.
    if (b.accentColor) {
        document.documentElement.style.setProperty(
            '--nx-accent-lineage', b.accentColor,
        )
    }
}
