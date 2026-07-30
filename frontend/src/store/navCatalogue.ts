/**
 * Nav catalogue store (RBAC Phase 16).
 *
 * Holds the section→permission visibility specs served by the backend
 * (`GET /me/nav`). Seeded with the compile-time defaults from
 * `lib/navPermissions.ts` so the shell renders synchronously on first
 * paint and degrades gracefully if the fetch is slow or unavailable;
 * `hydrate()` then reconciles to the authoritative served values.
 *
 * The catalogue is NOT user-specific — every authenticated user gets
 * the same specs and evaluates them against their own claims via
 * `useNavPermission` (in `store/auth.ts`). So we fetch it once on
 * bootstrap/login, not on every silent refresh.
 *
 * Components resolve live specs through `useSidebarSpec` /
 * `useAdminSectionSpec` rather than importing the static defaults, so
 * there is one runtime source of truth.
 */
import { create } from 'zustand'
import type { NavigationTab } from '@/store/navigation'
import {
    DEFAULT_SIDEBAR_PERMISSIONS,
    DEFAULT_ADMIN_SECTION_PERMISSIONS,
    type NavPermissionSpec,
} from '@/lib/navPermissions'
import { navService, type NavSection } from '@/services/navService'

interface NavCatalogueState {
    /** Sidebar section specs, keyed by NavigationTab. */
    sidebar: Record<string, NavPermissionSpec>
    /** Admin sub-section specs, keyed by route segment. */
    adminSections: Record<string, NavPermissionSpec>
    /** Display labels for sidebar sections (for the Feature Access map). */
    sidebarLabels: Record<string, string>
    /** Display labels for admin sections (for the Feature Access map). */
    adminLabels: Record<string, string>
    /**
     * True once we are DONE resolving the catalogue — whether the served
     * one arrived or the seed is what we're keeping.
     *
     * "Settled", not "succeeded", and the distinction is load-bearing:
     * ``RequireNav`` waits on this before rendering a denial, so a flag
     * that stayed false on a failed fetch would leave every nav-guarded
     * route showing a skeleton forever. An eternal spinner is not a safer
     * UI than a wrong answer — and the seed is not a wrong answer, it
     * mirrors the backend catalogue (guarded by the drift test).
     */
    loaded: boolean

    /** Fetch the catalogue and reconcile. Best-effort: a failure keeps
     *  the seed in place so the shell stays usable. */
    hydrate: () => Promise<void>
}

function specsFrom(sections: Record<string, NavSection>): {
    specs: Record<string, NavPermissionSpec>
    labels: Record<string, string>
} {
    const specs: Record<string, NavPermissionSpec> = {}
    const labels: Record<string, string> = {}
    for (const [key, section] of Object.entries(sections)) {
        specs[key] = section.spec
        labels[key] = section.label
    }
    return { specs, labels }
}

export const useNavCatalogueStore = create<NavCatalogueState>()((set) => ({
    // Seed from the bundled defaults so first paint is correct for the
    // common case (they mirror the backend; the drift test guards it).
    sidebar: { ...DEFAULT_SIDEBAR_PERMISSIONS },
    adminSections: { ...DEFAULT_ADMIN_SECTION_PERMISSIONS },
    sidebarLabels: {},
    adminLabels: {},
    loaded: false,

    hydrate: async () => {
        try {
            const cat = await navService.getCatalogue()
            const sidebar = specsFrom(cat.sidebar)
            const admin = specsFrom(cat.adminSections)
            set({
                sidebar: sidebar.specs,
                adminSections: admin.specs,
                sidebarLabels: sidebar.labels,
                adminLabels: admin.labels,
                loaded: true,
            })
        } catch {
            // Keep the seed — the shell stays usable. Route guards and
            // the sidebar fall back to the defaults, which match the
            // backend in the normal case.
            //
            // Still ``loaded: true``: this is the final answer available,
            // and ``RequireNav`` blocks on it. Leaving it false would turn
            // one failed catalogue fetch into a permanent skeleton on
            // every nav-guarded route.
            set({ loaded: true })
        }
    },
}))

// ── Selector hooks ───────────────────────────────────────────────────

/** Live visibility spec for a top-level sidebar tab. Falls back to a
 *  hidden-by-default ``perm`` on an unknown key so a typo never opens
 *  a section. */
// Stable fallback for unknown keys — fails closed. MUST be a module
// constant, not an inline literal: the selectors below feed
// ``useSyncExternalStore``, which treats a fresh object each call as a
// changed snapshot and spins into an infinite render loop. (RequireNav
// calls both selectors every render, so one always gets a key that's
// absent from its map and hits this fallback.)
const HIDDEN_SPEC: NavPermissionSpec = { kind: 'perm', perm: '__unknown__' }

export function useSidebarSpec(tab: NavigationTab): NavPermissionSpec {
    return useNavCatalogueStore((s) => s.sidebar[tab] ?? HIDDEN_SPEC)
}

/** Live visibility spec for an admin sub-section (keyed by route
 *  segment). Unknown keys fail closed. */
export function useAdminSectionSpec(path: string): NavPermissionSpec {
    return useNavCatalogueStore((s) => s.adminSections[path] ?? HIDDEN_SPEC)
}
