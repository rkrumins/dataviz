/**
 * Canonical role-name constants — the single source of truth for the
 * literal strings that identify every built-in role across the FE.
 *
 * Prior to this module, role names like ``'workspace_admin'`` were
 * hardcoded in ~12 places (KPI counters, role pickers, derivation
 * logic in the auth store, fallback descriptions). Renaming a role
 * therefore meant a wide silent-bug-prone sweep. Every FE consumer
 * now imports from here so a future role rename is a single edit.
 *
 * The backend's equivalent lives in ``backend/common/roles.py`` — the
 * two files must stay in lock-step. Migrations seed these names into
 * the ``roles`` table; this module mirrors them for the FE.
 */

export const ROLE_NAMES = {
    // ── Global platform tiers ──────────────────────────────────────
    SUPER_ADMIN: 'super_admin',
    ORG_ADMIN: 'org_admin',
    ORG_AUDITOR: 'org_auditor',
    /** Default tier for any user without an explicit global role. */
    USER: 'user',

    // ── Workspace-scoped role templates ────────────────────────────
    WORKSPACE_ADMIN: 'workspace_admin',
    WORKSPACE_DATA_ENGINEER: 'workspace_data_engineer',
    WORKSPACE_MEMBER: 'workspace_member',
    WORKSPACE_VIEWER: 'workspace_viewer',
} as const

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES]

/** Roles assignable via the ``PUT /admin/users/{id}/role`` endpoint —
 *  mirrors ``backend.app.db.repositories.user_repo.GLOBAL_ASSIGNABLE_ROLES``. */
export const GLOBAL_ASSIGNABLE_ROLES: readonly RoleName[] = [
    ROLE_NAMES.USER,
    ROLE_NAMES.ORG_AUDITOR,
    ROLE_NAMES.ORG_ADMIN,
    ROLE_NAMES.SUPER_ADMIN,
]

/** Subset of global tiers granted by the invite flow as a global role
 *  (everything else binds at workspace scope). Mirrors
 *  ``backend.app.api.v1.endpoints.auth._INVITE_GLOBAL_TIER``. */
export const INVITE_GLOBAL_TIER: ReadonlySet<RoleName> = new Set([
    ROLE_NAMES.SUPER_ADMIN,
    ROLE_NAMES.ORG_ADMIN,
])

/** The three platform-level admin tiers — used to show the "Admin"
 *  badge in TopBar, count "Admins" KPI on AdminUsers, etc. */
export const PLATFORM_ADMIN_ROLES: ReadonlySet<RoleName> = new Set([
    ROLE_NAMES.SUPER_ADMIN,
    ROLE_NAMES.ORG_ADMIN,
])

/** Workspace role templates — assignable on the workspace-member
 *  binding form and used as KPI counter buckets. */
export const WORKSPACE_TEMPLATE_ROLES: readonly RoleName[] = [
    ROLE_NAMES.WORKSPACE_ADMIN,
    ROLE_NAMES.WORKSPACE_DATA_ENGINEER,
    ROLE_NAMES.WORKSPACE_MEMBER,
    ROLE_NAMES.WORKSPACE_VIEWER,
]

export const WORKSPACE_TEMPLATE_ROLE_SET: ReadonlySet<RoleName> = new Set(
    WORKSPACE_TEMPLATE_ROLES,
)

/** Roles automatically excluded from SSO group-mapping pickers and
 *  similar auto-grant flows. Matches the backend's
 *  ``FORBIDDEN_AUTO_ROLE`` guard in ``idp_group_mapping_repo``. */
export const FORBIDDEN_AUTO_GRANT_ROLES: ReadonlySet<RoleName> = new Set([
    ROLE_NAMES.SUPER_ADMIN,
])
