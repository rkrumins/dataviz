/**
 * Centralised navigation visibility catalogue.
 *
 * One place that maps every sidebar entry + admin sub-page to the
 * permission(s) the user must hold to see it. Mirrors the backend
 * endpoint gates so the FE never drifts.
 *
 * When a backend gate changes (e.g. a new admin section gets its own
 * ``requires(...)`` decorator), update the matching entry here — that's
 * the only place the FE needs to learn about it.
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
export const SIDEBAR_PERMISSIONS: Record<NavigationTab, NavPermissionSpec> = {
    dashboard:  { kind: 'always' },
    explore:    { kind: 'always' },
    workspaces: { kind: 'always' },
    ingestion:  { kind: 'anyPerm', perms: ['system:admin', 'system:org-admin', 'workspace:datasource:manage'] },
    schema:     { kind: 'anyPerm', perms: ['system:admin', 'system:org-admin', 'workspace:datasource:read'] },
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
export const ADMIN_SECTION_PERMISSIONS: Record<string, NavPermissionSpec> = {
    overview:      { kind: 'perm', perm: 'system:admin' },
    features:      { kind: 'perm', perm: 'system:admin' },
    announcements: { kind: 'perm', perm: 'system:admin' },
    users:         { kind: 'perm', perm: 'system:admin' },
    groups:        { kind: 'perm', perm: 'system:groups:manage' },
    permissions:   { kind: 'perm', perm: 'system:admin' },
    sso:           { kind: 'perm', perm: 'system:admin' },
    audit:         { kind: 'perm', perm: 'system:admin' },
}
