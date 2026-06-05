/**
 * Nav catalogue service — fetches the centralised section→permission
 * visibility map from the backend (RBAC Phase 16).
 *
 * The backend (`backend/app/services/nav_catalogue.py`) is the single
 * source of truth for which permission unlocks which UI section. The
 * frontend used to hardcode this in `lib/navPermissions.ts`; now that
 * file is only a compile-time *seed/fallback* and the authoritative
 * specs come from here, served by `GET /me/nav`.
 *
 * The catalogue is static (not personalised) — the FE still evaluates
 * each spec against the caller's own claims client-side via
 * `useNavPermission`.
 */
import { authFetch } from './apiClient'
import type { NavPermissionSpec } from '@/lib/navPermissions'

const ME_API = '/api/v1/me'

/** One catalogue entry: stable key, display label, and the spec the FE
 *  evaluates against the user's permission claims. */
export interface NavSection {
    key: string
    label: string
    spec: NavPermissionSpec
}

export interface NavCatalogueResponse {
    sidebar: Record<string, NavSection>
    adminSections: Record<string, NavSection>
}

export const navService = {
    /** Fetch the section catalogue. Served to every authenticated user;
     *  the response is identical for everyone (gating happens FE-side
     *  against each user's claims). Safe to cache for the session. */
    getCatalogue(): Promise<NavCatalogueResponse> {
        return authFetch<NavCatalogueResponse>(`${ME_API}/nav`)
    },
}
