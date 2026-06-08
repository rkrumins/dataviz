/**
 * Landing branding service — fetches the deployment's live brand identity
 * from the backend's public, unauthenticated `GET /api/v1/branding` (the
 * same endpoint the admin UI writes through), so a system-admin's branding
 * changes propagate to the marketing site.
 *
 * The landing is often deployed standalone with no backend reachable, so
 * this must fail soft: any error/timeout returns `null` and the caller
 * keeps the bundled build-time defaults. The endpoint is configurable via
 * `VITE_BRANDING_API_URL` (default: same-origin `/api/v1/branding`) for
 * deployments where the API lives on another origin.
 */

const ENDPOINT =
    import.meta.env.VITE_BRANDING_API_URL ?? '/api/v1/branding'

/** Subset of the public branding payload the landing consumes. Every field
 *  the backend serves is present; we type only what we use. */
export interface Branding {
    appName: string
    shortName: string
    description: string
    logoUrl: string
    faviconUrl: string
    accentColor: string
}

/** Fetch the public branding. Returns `null` on any failure (no backend,
 *  network error, non-2xx, or timeout) so the caller falls back to the
 *  build-time defaults and the page still renders. */
export async function fetchPublicBranding(): Promise<Branding | null> {
    try {
        // Bound the wait so a missing/slow backend never delays first paint.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(ENDPOINT, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        })
        clearTimeout(timer)
        if (!res.ok) return null
        return (await res.json()) as Branding
    } catch {
        return null
    }
}
