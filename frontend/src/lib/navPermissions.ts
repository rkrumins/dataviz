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
import type { PermissionResponse } from '@/services/permissionsService'

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
    // `system:analytics:read` is the dedicated privilege and leads for that
    // reason; the rest are the audiences that predate it and don't imply each
    // other — auditors (system:audit:read) and cross-workspace operators
    // (system:org-admin). This list must stay identical to the server's
    // PRIVILEGED_PERMISSIONS and to the nav catalogue: `useAnalyticsAccess`
    // reads it to decide who is privileged, so a permission missing here is a
    // route the holder is REFUSED — with a panel telling them the section is
    // not open on this deployment, while the server would have served them all
    // of it. This is the pre-hydration fallback for `GET /me/nav`, so it is
    // also what a reader gets on first paint and whenever that call fails.
    // Note this is the PRIVILEGED spec only — `analyticsPublicEnabled` opens a
    // redacted section to everyone else, and that OR lives in
    // `useAnalyticsAccess` because a flag is not a permission.
    analytics:  { kind: 'anyPerm', perms: ['system:analytics:read', 'system:admin', 'system:org-admin', 'system:audit:read'] },
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
    overview:       { kind: 'perm', perm: 'system:admin' },
    infrastructure: { kind: 'perm', perm: 'system:admin' },
    branding:      { kind: 'perm', perm: 'system:admin' },
    features:      { kind: 'perm', perm: 'system:admin' },
    telemetry:     { kind: 'perm', perm: 'system:audit:read' },
    announcements: { kind: 'perm', perm: 'system:admin' },
    users:         { kind: 'perm', perm: 'system:admin' },
    groups:        { kind: 'perm', perm: 'system:groups:manage' },
    permissions:   { kind: 'perm', perm: 'system:admin' },
    sso:           { kind: 'perm', perm: 'system:admin' },
    audit:         { kind: 'perm', perm: 'system:audit:read' },
}


// ── Role → spec evaluation (for the admin Feature Access map) ────────
// Source of truth is the backend permission catalogue (served by
// ``GET /admin/permissions``). Each catalogue entry carries an
// ``impliedBy`` list — the perms whose grant auto-implies it in the
// same scope. We previously kept a hardcoded ``WORKSPACE_LEAVES``
// array here, but it drifted when Phase 18 added new workspace perms
// and the BE updated its resolver while the FE was forgotten. Now
// implications come from the catalogue; the FE has no leaf list.

/** Expand a role's granted permission list to its effective set,
 *  applying the same implications the backend resolver does. The
 *  ``catalog`` argument is the array returned by ``listPermissions()``
 *  — typically the same one already loaded into ``AdminPermissions``
 *  for the Role Matrix and custom-role builder. */
export function roleEffectivePermissions(
    perms: string[],
    catalog: PermissionResponse[],
): Set<string> {
    const set = new Set(perms)
    // Fixed-point expansion in case future catalogue entries chain
    // (e.g. workspace:admin → leaf → …). Today the chain is depth-1,
    // but the loop keeps the call site safe and matches how the
    // backend resolver builds effective claims.
    let grew = true
    while (grew) {
        grew = false
        for (const p of catalog) {
            if (set.has(p.id)) continue
            if (p.impliedBy.some((src) => set.has(src))) {
                set.add(p.id)
                grew = true
            }
        }
    }
    return set
}

function permSatisfied(effective: Set<string>, perm: string): boolean {
    if (effective.has('system:admin')) return true
    if (effective.has(perm)) return true
    // Wildcard grant (e.g. ``workspace:view:*``) covers its leaves.
    // Kept for backwards-compatibility with any legacy role grants
    // that still use the wildcard form; orthogonal to ``impliedBy``.
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
export function roleSatisfiesSpec(
    perms: string[],
    spec: NavPermissionSpec,
    catalog: PermissionResponse[],
): boolean {
    const eff = roleEffectivePermissions(perms, catalog)
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
