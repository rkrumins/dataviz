/**
 * Branding service — white-label app identity.
 *
 * The public ``GET /api/v1/branding`` is fetched on boot BEFORE auth (the
 * login page, tab title and favicon need it without a session), so it uses
 * a plain ``fetch`` rather than ``authFetch`` — no cookie/CSRF/refresh
 * machinery, and a failure must never block the shell.
 *
 * Admin reads/writes go through ``authFetch`` (cookie-gated) and back the
 * Admin → Branding settings page.
 */
import { authFetch } from './apiClient'

const API = '/api/v1'

/** Resolved branding payload. Every field is always present — the
 *  backend fills any unset value from the ``APP_BRAND_*`` env defaults. */
export interface Branding {
    appName: string
    shortName: string
    description: string
    logoUrl: string
    faviconUrl: string
    accentColor: string
    copyrightText: string
    supportEmail: string
    loginTagline: string
    version: number
    updatedAt: string
}

/** Partial update body for the admin PATCH. ``expectedVersion`` binds the
 *  change to the version the admin saw (optimistic concurrency). The
 *  ``*Data``/``*Mime`` fields are only sent (as empty strings) to clear a
 *  previously uploaded image so a pasted URL / the default mark can win. */
export type BrandingPatch = Partial<
    Omit<Branding, 'version' | 'updatedAt'>
> & {
    expectedVersion?: number
    logoData?: string
    logoMime?: string
    faviconData?: string
    faviconMime?: string
}

/** Public fetch — no auth. Returns ``null`` on any failure so the caller
 *  can fall back to the bundled defaults and keep rendering. */
export async function fetchPublicBranding(): Promise<Branding | null> {
    try {
        const res = await fetch(`${API}/branding`, {
            headers: { Accept: 'application/json' },
        })
        if (!res.ok) return null
        return (await res.json()) as Branding
    } catch {
        return null
    }
}

/** Admin read — cookie-gated, behind ``system:admin``. */
export function fetchAdminBranding(): Promise<Branding> {
    return authFetch<Branding>(`${API}/admin/branding`)
}

/** Admin update — optimistic concurrency via ``expectedVersion``. */
export function updateBranding(patch: BrandingPatch): Promise<Branding> {
    return authFetch<Branding>(`${API}/admin/branding`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    })
}

/** Reset all branding to the deployment (env) defaults. */
export function resetBranding(): Promise<Branding> {
    return authFetch<Branding>(`${API}/admin/branding/reset`, {
        method: 'POST',
    })
}

/** Upload a logo or favicon image (multipart). Stored base64 server-side. */
export function uploadBrandingImage(
    kind: 'logo' | 'favicon',
    file: File,
): Promise<Branding> {
    const form = new FormData()
    form.append('file', file)
    return authFetch<Branding>(`${API}/admin/branding/${kind}`, {
        method: 'POST',
        body: form,
    })
}
