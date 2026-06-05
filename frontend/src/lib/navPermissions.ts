/**
 * Navigation visibility defaults (compile-time seed).
 *
 * Phase 16: the authoritative section→permission catalogue now lives
 * in the backend (``backend/app/services/nav_catalogue.py``) and is
 * served via ``GET /me/nav`` into ``store/navCatalogue.ts``. These
 * records are the **fallback** the FE ships with so the shell renders
 * synchronously before the fetch resolves (and if the endpoint is
 * briefly unavailable). They must mirror the backend; a drift test
 * (``backend/tests/test_nav_catalogue.py``) guards the backend side,
 * and the store reconciles to the served values once loaded.
 *
 * Consumers should read live specs from the catalogue store
 * (``useSidebarSpec`` / ``useAdminSectionSpec``), not import these
 * directly — they exist only as the seed.
 */
import type { NavigationTab } from '@/store/navigation'

/**
 * A visibility rule. Components consume these via ``useNavPermission``
 * so the hook-call shape is uniform regardless of variant.
 *
 *   * ``always``        — every authenticated user.
 *   * ``perm``          — single global permission required.
 *   * ``anyPerm``       — any of N global permissions satisfies.
 *   * ``workspaceAny``  — perm held in ANY workspace bucket
 *     (used for items that depend on workspace-scoped access).
 */
export type NavPermissionSpec =
    | { kind: 'always' }
    | { kind: 'perm'; perm: string }
    | { kind: 'anyPerm'; perms: string[] }
    | { kind: 'workspaceAny'; perm: string }

/**
 * Top-level sidebar (left rail).
 *
 * ``ingestion`` and ``schema`` use ``anyPerm`` listing the global
 * shortcuts (``system:admin``, ``system:org-admin``) PLUS the
 * underlying workspace-scoped perm. The global shortcuts are checked
 * via ``checkPermission`` (which honours them); the workspace-scoped
 * perm gets the wildcard-aware "any workspace" lookup via
 * ``useAnyWorkspacePermission``. Listing both explicitly here keeps
 * the spec greppable.
 */
export const DEFAULT_SIDEBAR_PERMISSIONS: Record<NavigationTab, NavPermissionSpec> = {
    dashboard:  { kind: 'always' },
    explore:    { kind: 'always' },
    workspaces: { kind: 'always' },
    // Phase 18: Ingestion + Semantic Layers open to workspace-bound
    // readers via the new workspace:provider:read /
    // workspace:ontology:read perms; pages render filtered results and
    // gate edit affordances separately.
    ingestion:  { kind: 'anyPerm', perms: ['system:admin', 'system:org-admin', 'workspace:provider:read', 'workspace:datasource:manage'] },
    schema:     { kind: 'anyPerm', perms: ['system:admin', 'system:org-admin', 'workspace:ontology:read'] },
    admin:      { kind: 'anyPerm', perms: ['system:admin', 'system:groups:manage'] },
}

/**
 * Admin sub-nav. Keyed by the route segment (matches
 * ``AdminPage.adminGroups[].items[].path`` and the route
 * children in ``routes.tsx``).
 *
 * Every entry except ``groups`` requires ``system:admin``. ``groups``
 * has its own ``system:groups:manage`` permission so a delegated
 * groups admin can land there without being a full super-admin.
 */
export const DEFAULT_ADMIN_SECTION_PERMISSIONS: Record<string, NavPermissionSpec> = {
    overview:      { kind: 'perm', perm: 'system:admin' },
    features:      { kind: 'perm', perm: 'system:admin' },
    announcements: { kind: 'perm', perm: 'system:admin' },
    users:         { kind: 'perm', perm: 'system:admin' },
    groups:        { kind: 'perm', perm: 'system:groups:manage' },
    permissions:   { kind: 'perm', perm: 'system:admin' },
    sso:           { kind: 'perm', perm: 'system:admin' },
    audit:         { kind: 'perm', perm: 'system:admin' },
}


// ── Role → spec evaluation (for the admin Feature Access map) ────────
// Mirrors the backend resolver's implications so the admin map shows
// which roles can reach each section accurately:
//   * ``system:admin`` implies every permission.
//   * ``workspace:admin`` implies every other ``workspace:*`` leaf.
// Kept here next to the spec type so the semantics live in one place.

const WORKSPACE_LEAVES = [
    'workspace:admin',
    'workspace:datasource:manage',
    'workspace:datasource:read',
    'workspace:view:create',
    'workspace:view:edit',
    'workspace:view:delete',
    'workspace:view:read',
]

/** Expand a role's granted permission list to its effective set,
 *  applying the same implications the backend resolver does. */
export function roleEffectivePermissions(perms: string[]): Set<string> {
    const set = new Set(perms)
    if (set.has('workspace:admin')) {
        for (const leaf of WORKSPACE_LEAVES) set.add(leaf)
    }
    return set
}

function permSatisfied(effective: Set<string>, perm: string): boolean {
    if (effective.has('system:admin')) return true
    if (effective.has(perm)) return true
    // Wildcard grant (e.g. ``workspace:view:*``) covers its leaves.
    for (const granted of effective) {
        if (granted.endsWith(':*') && perm.startsWith(granted.slice(0, -2) + ':')) {
            return true
        }
    }
    return false
}

/** Would a role with these granted permissions satisfy a nav spec?
 *  Used by the read-only Feature Access map to list, per section, the
 *  roles that unlock it. Pure — no claims, no store. */
export function roleSatisfiesSpec(perms: string[], spec: NavPermissionSpec): boolean {
    const eff = roleEffectivePermissions(perms)
    switch (spec.kind) {
        case 'always':
            return true
        case 'perm':
            return permSatisfied(eff, spec.perm)
        case 'anyPerm':
            return spec.perms.some((p) => permSatisfied(eff, p))
        case 'workspaceAny':
            return permSatisfied(eff, spec.perm)
    }
}
