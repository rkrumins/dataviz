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
    appName: 'Context Visualization Platform',
    shortName: 'CVP',
    description: 'Interactive Data Lineage Visualization',
    logoUrl: '',
    faviconUrl: '/nexus-icon.svg',
    accentColor: '#6366f1',
    copyrightText: '© 2026 Context Visualization Platform',
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

/** localStorage key holding a compact brand cache (title/favicon/accent/
 *  apple icon). Written by ``applyBranding``; read synchronously by the
 *  inline bootstrap script in index.html to paint the brand before React
 *  mounts, eliminating the title/favicon flash for returning visitors.
 *  Keep this key in sync with that inline script. */
const BRAND_CACHE_KEY = 'nx-brand-cache'

/** Set (or create) a <link> in <head> by rel, returning it. */
function ensureLink(rel: string): HTMLLinkElement {
    let link = document.querySelector<HTMLLinkElement>(`link[rel='${rel}']`)
    if (!link) {
        link = document.createElement('link')
        link.rel = rel
        document.head.appendChild(link)
    }
    return link
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

    // Favicon + apple-touch-icon — swap the existing <link> hrefs (the
    // inline bootstrap may have already created them), or create them.
    if (b.faviconUrl) {
        let icon = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
        if (!icon) {
            icon = document.createElement('link')
            icon.rel = 'icon'
            document.head.appendChild(icon)
        }
        icon.href = b.faviconUrl
        ensureLink('apple-touch-icon').href = b.faviconUrl
    }

    // Accent colour — drive the primary accent CSS variable the theme
    // already keys off (``--nx-accent-lineage``). Only the primary accent
    // is overridden; the semantic business/technical/warning accents keep
    // their meaning. Guard against a blank value clearing the default.
    if (b.accentColor) {
        document.documentElement.style.setProperty(
            '--nx-accent-lineage', b.accentColor,
        )
        // Mobile browser chrome / PWA install colour follows the accent.
        let meta = document.querySelector<HTMLMetaElement>(
            "meta[name='theme-color']:not([media])",
        )
        if (!meta) {
            meta = document.createElement('meta')
            meta.name = 'theme-color'
            document.head.appendChild(meta)
        }
        meta.content = b.accentColor
    }

    // Persist a compact cache so the next load can paint the brand before
    // React boots (see the inline script in index.html). Best-effort.
    try {
        localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({
            title: b.appName,
            favicon: b.faviconUrl,
            accent: b.accentColor,
        }))
    } catch {
        // private mode / quota — the flash fix simply won't apply.
    }
}
