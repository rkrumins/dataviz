/**
 * Brand context — resolves the landing site's brand identity at runtime.
 *
 * Seeds from the build-time `BRAND` defaults so first paint is correct (and
 * standalone deploys with no backend render fine), then fetches the live
 * public branding and merges it over the defaults — so a system-admin's
 * changes in the main app's Admin → Branding page propagate here. Also owns
 * the document-level side-effects (tab title, favicon, accent CSS var),
 * mirroring `applyBranding` in the main app's brand store.
 *
 * Landing has no state lib, so this is a plain React context. The landing
 * only ever *reads* the public endpoint — it never writes branding — so the
 * "only a system admin can change branding" guarantee is unaffected.
 */
import {
    createContext, useContext, useEffect, useState,
    type ReactNode,
} from 'react'
import { BRAND } from '@/config/brand'
import { fetchPublicBranding, type Branding } from '@/services/brandingService'

const DEFAULT_ICON = '/nexus-icon.svg'
const DEFAULT_ACCENT = '#6366f1' // matches --nx-accent-lineage in globals.css

/** The brand shape components consume. */
export interface ResolvedBrand {
    name: string
    shortName: string
    description: string
    logoSrc: string
    faviconSrc: string
    accentColor: string
}

/** Build-time defaults — used until (or unless) the fetch succeeds. */
const DEFAULT_BRAND: ResolvedBrand = {
    name: BRAND.name,
    shortName: BRAND.shortName,
    description: BRAND.description,
    logoSrc: DEFAULT_ICON,
    faviconSrc: DEFAULT_ICON,
    accentColor: DEFAULT_ACCENT,
}

/** Map a served payload onto the resolved shape, falling back per-field so a
 *  partially-set deployment still renders. Uploaded logo wins, then a hosted
 *  URL, then the bundled mark. */
function resolve(served: Branding): ResolvedBrand {
    return {
        name: served.appName || DEFAULT_BRAND.name,
        shortName: served.shortName || DEFAULT_BRAND.shortName,
        description: served.description || DEFAULT_BRAND.description,
        logoSrc: served.logoUrl || served.faviconUrl || DEFAULT_ICON,
        faviconSrc: served.faviconUrl || DEFAULT_ICON,
        accentColor: served.accentColor || DEFAULT_ACCENT,
    }
}

/** Apply the document-level side-effects of branding. Idempotent. */
function applyBranding(b: ResolvedBrand): void {
    document.title = `${b.name} — ${b.description}`

    setLink('icon', b.faviconSrc)
    setLink('apple-touch-icon', b.faviconSrc)

    document.documentElement.style.setProperty(
        '--nx-accent-lineage', b.accentColor,
    )
}

/** Set (or create) a <link rel> href in <head>. */
function setLink(rel: string, href: string): void {
    let link = document.querySelector<HTMLLinkElement>(`link[rel='${rel}']`)
    if (!link) {
        link = document.createElement('link')
        link.rel = rel
        document.head.appendChild(link)
    }
    link.href = href
}

const BrandContext = createContext<ResolvedBrand>(DEFAULT_BRAND)

export function BrandProvider({ children }: { children: ReactNode }) {
    const [brand, setBrand] = useState<ResolvedBrand>(DEFAULT_BRAND)

    useEffect(() => {
        let cancelled = false
        void fetchPublicBranding().then((served) => {
            if (cancelled || !served) return // no backend → keep defaults
            const resolved = resolve(served)
            setBrand(resolved)
            applyBranding(resolved)
        })
        return () => { cancelled = true }
    }, [])

    return (
        <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
    )
}

/** Live resolved brand. Re-renders consumers when the fetch reconciles. */
export function useBrand(): ResolvedBrand {
    return useContext(BrandContext)
}
