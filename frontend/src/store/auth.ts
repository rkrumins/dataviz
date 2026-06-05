/**
 * Auth store — session state derived from the server, never persisted client-side.
 *
 * The previous implementation kept ``isAuthenticated`` and a JWT in
 * localStorage under ``nexus-auth-storage``. Anyone could open DevTools,
 * flip the boolean to ``true``, and the route guard would let them in
 * because nothing validated the stored state against the backend.
 *
 * Now:
 *   * The session lives in HttpOnly cookies that JS cannot read.
 *   * On boot we call ``GET /auth/me`` once. The server is the only
 *     authority on whether the cookie is valid; ``isAuthenticated`` is a
 *     derived projection of the resulting status.
 *   * Nothing about auth is written to localStorage.
 */

import { create } from 'zustand'
import {
    authService,
    type AuthUser,
    type PermissionClaims,
    type SignUpRequest,
} from '@/services/authService'
import {
    clearUserCache,
    readUserCache,
    writeUserCache,
} from '@/store/userCache'
import type { NavPermissionSpec } from '@/lib/navPermissions'
import { useNavCatalogueStore } from '@/store/navCatalogue'

export type { PermissionClaims }

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated'

/**
 * The frontend treats permission claims as **advisory** — the backend
 * remains the source of truth and will 403 anything not actually
 * allowed. UI gating only hides controls so users don't see (or
 * click) actions they can't perform.
 */
const EMPTY_CLAIMS: PermissionClaims = { sid: '', global: [], ws: {} }

/**
 * Phase 5 role taxonomy — exported so consumers don't have to
 * hand-roll the string literals. Bound contexts:
 *
 *   * ``super_admin``     — global, full platform access
 *   * ``org_admin``       — global, every workspace power w/o user/SSO admin
 *   * ``workspace_admin`` — workspace, auto-implies every workspace:*
 *   * ``workspace_member``— workspace, manage views + data sources
 *   * ``workspace_viewer``— workspace, read-only
 */
export type SystemRole =
    | 'super_admin'
    | 'org_admin'
    | 'workspace_admin'
    | 'workspace_member'
    | 'workspace_viewer'

export const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = {
    super_admin: 'Super Admin',
    org_admin: 'Org Admin',
    workspace_admin: 'Workspace Admin',
    workspace_member: 'Member',
    workspace_viewer: 'Viewer',
}

/**
 * Check a single permission against the claim. Mirrors the server-side
 * ``has_permission`` exactly:
 *
 *   * ``system:admin`` global short-circuit (super_admin)
 *   * ``system:org-admin`` shortcut for any workspace-scoped check
 *     (Phase 5; org_admin acts in every workspace without per-ws
 *     bindings)
 *   * Wildcard expansion (``workspace:view:*`` matches every leaf)
 *
 * @param permission e.g. ``"workspace:view:edit"`` or ``"system:workspaces:create"``
 * @param workspaceId required for workspace-scoped permissions; pass
 *   undefined for global ones.
 */
export function checkPermission(
    claims: PermissionClaims,
    permission: string,
    workspaceId?: string | null,
): boolean {
    // 1. Super-admin shortcut: implies every permission, every scope.
    if (claims.global.includes('system:admin')) return true

    // 2. Phase 5 org-admin shortcut: any workspace-scoped check passes
    //    in any workspace. The FE topbar surfaces this as "Org Admin"
    //    and MyAccessPage renders the explicit reason.
    if (workspaceId && claims.global.includes('system:org-admin')) {
        return true
    }

    if (!workspaceId) {
        return claims.global.includes(permission)
    }

    const bucket = claims.ws[workspaceId]
    if (!bucket) return false
    if (bucket.includes(permission)) return true
    // Wildcard match: claim 'workspace:view:*' matches lookup
    // 'workspace:view:edit'.
    for (const granted of bucket) {
        if (granted.endsWith(':*')) {
            const prefix = granted.slice(0, -2)
            if (permission.startsWith(prefix + ':')) return true
        }
    }
    return false
}

/**
 * Compute the user's effective tier for display purposes. Mirrors the
 * order the resolver applies on the backend:
 *
 *   1. super_admin   → ``system:admin`` in global_perms
 *   2. org_admin     → ``system:org-admin`` in global_perms
 *   3. workspace_admin   → ``workspace:admin`` in the named ws bucket
 *   4. workspace_member  → any workspace:view:edit in the named ws bucket
 *   5. workspace_viewer  → any workspace:view:read in the named ws bucket
 *   6. null          → no role in this scope
 *
 * The TopBar uses this with the active workspace id to render a
 * workspace-aware role badge (a user can be admin in finance and viewer
 * in marketing — the badge changes when they navigate).
 */
export function effectiveRoleFor(
    claims: PermissionClaims,
    workspaceId?: string | null,
): SystemRole | null {
    if (claims.global.includes('system:admin')) return 'super_admin'
    if (claims.global.includes('system:org-admin')) return 'org_admin'
    if (!workspaceId) return null
    const bucket = claims.ws[workspaceId]
    if (!bucket) return null
    if (bucket.includes('workspace:admin')) return 'workspace_admin'
    // Use wildcard-aware checks so a 'workspace:view:*' / 'workspace:view:edit'
    // claim correctly resolves to "member".
    if (checkPermission(claims, 'workspace:view:edit', workspaceId)) {
        return 'workspace_member'
    }
    if (checkPermission(claims, 'workspace:view:read', workspaceId)) {
        return 'workspace_viewer'
    }
    return null
}

interface AuthState {
    status: AuthStatus
    /** Convenience derivation of ``status === 'authenticated'``. Kept in
     *  sync on every status change so existing call sites that destructure
     *  ``isAuthenticated`` from the store keep working. */
    isAuthenticated: boolean
    user: AuthUser | null
    permissions: PermissionClaims
    error: string | null
    isLoading: boolean

    /** Call once on app boot — asks the server whether the cookie is valid. */
    bootstrap: () => Promise<void>
    login: (email: string, password: string) => Promise<boolean>
    signup: (req: SignUpRequest) => Promise<{ ok: boolean; message: string }>
    logout: () => Promise<void>
    /** Internal: invoked by apiClient when a 401 cannot be recovered. */
    handleSessionLost: () => void
    /** Internal: invoked after login / silent refresh hydrates claims. */
    setPermissions: (claims: PermissionClaims) => void
    /** Phase 10: re-fetch ``/me/permissions`` after a silent refresh
     *  so route guards and TopBar react to role / binding mutations
     *  that happened mid-session. Fire-and-forget — failures clear
     *  the claim to empty so guards fail-closed until the next page
     *  load. */
    refreshPermissions: () => Promise<void>
    clearError: () => void
    /** Predicate helpers used by UI components. Reading the store via
     *  these instead of hand-rolling the check keeps the wildcard +
     *  admin-shortcut logic in one place. */
    can: (permission: string, workspaceId?: string | null) => boolean
    canAny: (permissions: string[], workspaceId?: string | null) => boolean
    canAll: (permissions: string[], workspaceId?: string | null) => boolean
}

const _unauthenticated = {
    status: 'unauthenticated' as const,
    isAuthenticated: false,
    user: null,
    permissions: EMPTY_CLAIMS,
}

const _authenticated = (user: AuthUser) => ({
    status: 'authenticated' as const,
    isAuthenticated: true,
    user,
})

export const useAuthStore = create<AuthState>()((set, get) => ({
    status: 'idle',
    isAuthenticated: false,
    user: null,
    permissions: EMPTY_CLAIMS,
    error: null,
    isLoading: false,

    bootstrap: async () => {
        // Idempotent: skip if already resolved or in flight.
        const current = get().status
        if (current === 'loading' || current === 'authenticated') return

        // Optimistic seed from the sessionStorage cache so the shell
        // can render synchronously on reload. The cookie is still the
        // source of truth — the /auth/me call below confirms or
        // wipes this seed. Permissions are deliberately NOT seeded:
        // a role demotion between sessions must never surface admin
        // UI to a now-non-admin user.
        const cached = readUserCache()
        if (cached !== null) {
            set({ ..._authenticated(cached), error: null })
        } else {
            set({ status: 'loading' })
        }

        try {
            const { user } = await authService.me()
            // Re-apply with the server's freshly-returned DTO so
            // role/status updates from the backend overwrite the
            // optimistic copy.
            set({ ..._authenticated(user), error: null })
            writeUserCache(user)
            // Hydrate permissions in the background — failure here
            // doesn't unauthenticate the user, it just means the FE
            // gates fall closed until next refresh.
            await hydratePermissions(set)
            // Phase 16: pull the nav catalogue (section→permission map)
            // once so the sidebar + route guards read live specs.
            // Seeded with bundled defaults, so this is non-fatal.
            void useNavCatalogueStore.getState().hydrate()
        } catch {
            // Any failure (no cookie, expired, server down) →
            // unauthenticated. Wipe the cache so the next boot in
            // this tab doesn't repeat the optimistic-then-reject
            // flicker. The user lands on /login; route guards do the
            // rest.
            clearUserCache()
            set({ ..._unauthenticated, error: null })
        }
    },

    login: async (email, password) => {
        set({ error: null, isLoading: true })
        try {
            const { user } = await authService.login({ email, password })
            set({ ..._authenticated(user), error: null, isLoading: false })
            writeUserCache(user)
            await hydratePermissions(set)
            // Phase 16: load the nav catalogue post-login (see bootstrap).
            void useNavCatalogueStore.getState().hydrate()
            return true
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Login failed'
            clearUserCache()
            set({ ..._unauthenticated, error: message, isLoading: false })
            return false
        }
    },

    signup: async (req) => {
        set({ error: null, isLoading: true })
        try {
            const resp = await authService.signup(req)
            set({ isLoading: false })
            return { ok: true, message: resp.message }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Signup failed'
            set({ error: message, isLoading: false })
            return { ok: false, message }
        }
    },

    logout: async () => {
        // Best-effort: call /logout so the server can revoke the refresh
        // family. Even if it fails (network down, etc.) we still clear
        // local state — the user is logging out either way.
        try {
            await authService.logout()
        } catch {
            // ignore
        }
        clearUserCache()
        set({ ..._unauthenticated, error: null, isLoading: false })
    },

    handleSessionLost: () => {
        clearUserCache()
        set({ ..._unauthenticated, error: null })
    },

    setPermissions: (permissions) => set({ permissions }),

    refreshPermissions: async () => {
        // Mirrors ``hydratePermissions`` but called from outside the
        // login / bootstrap flow. Used by ``fetchWithTimeout`` after
        // a successful silent refresh — the new JWT carries
        // re-resolved claims (auth_service/service.py:365) and the
        // FE store needs to catch up so route guards stop blocking
        // a freshly-promoted admin.
        await hydratePermissions(set)
    },

    clearError: () => set({ error: null }),

    can: (permission, workspaceId) =>
        checkPermission(get().permissions, permission, workspaceId),

    canAny: (permissions, workspaceId) => {
        const claims = get().permissions
        return permissions.some((p) => checkPermission(claims, p, workspaceId))
    },

    canAll: (permissions, workspaceId) => {
        const claims = get().permissions
        return permissions.every((p) => checkPermission(claims, p, workspaceId))
    },
}))


/**
 * Fetch ``/api/v1/me/permissions`` and stash the result in the store.
 *
 * Pulled out of the actions so login + bootstrap (and later, the silent
 * refresh handler) share one implementation. Failures clear the
 * permissions back to empty rather than crashing the auth flow — a
 * temporary outage of the permissions endpoint shouldn't log the user
 * out, just hide everything until they reload.
 */
async function hydratePermissions(
    set: (partial: Partial<AuthState>) => void,
): Promise<void> {
    try {
        const claims = await authService.myPermissions()
        set({ permissions: claims })
    } catch {
        set({ permissions: EMPTY_CLAIMS })
    }
}


// ── Selector hooks ───────────────────────────────────────────────────
// Components prefer narrow selectors over reading the whole store so
// re-renders stay scoped to the slice they actually care about.

/**
 * Reactive permission check. Re-renders only when the permissions
 * slice changes (or the workspaceId argument changes).
 */
export function usePermission(
    permission: string,
    workspaceId?: string | null,
): boolean {
    return useAuthStore((s) => checkPermission(s.permissions, permission, workspaceId))
}

/** Read the raw claims slice — useful for components that need to
 *  derive multiple checks from the same render. */
export function usePermissionClaims(): PermissionClaims {
    return useAuthStore((s) => s.permissions)
}

/**
 * Any-of global permission check. Re-renders when the permissions
 * slice changes.
 */
export function useAnyPermission(perms: string[]): boolean {
    return useAuthStore((s) => s.canAny(perms))
}

/**
 * True when the permission is satisfied in ANY workspace bucket the
 * user holds — useful for sidebar items that point at workspace-bound
 * features (e.g. Ingestion needs ``workspace:datasource:manage`` in
 * at least one workspace to be worth showing).
 *
 * Honours the same global short-circuits + wildcard expansion that
 * ``checkPermission`` already applies.
 */
export function useAnyWorkspacePermission(perm: string): boolean {
    return useAuthStore((s) => {
        const claims = s.permissions
        if (claims.global.includes('system:admin')) return true
        if (claims.global.includes('system:org-admin')) return true
        for (const wsId of Object.keys(claims.ws)) {
            if (checkPermission(claims, perm, wsId)) return true
        }
        return false
    })
}

/**
 * Dispatch helper for ``NavPermissionSpec``. Sidebars and the
 * ``RequireNav`` route wrapper consume this so they don't have to
 * branch on the spec kind themselves.
 */
export function useNavPermission(spec: NavPermissionSpec): boolean {
    const can = useAuthStore((s) => s.can)
    const canAny = useAuthStore((s) => s.canAny)
    const claims = useAuthStore((s) => s.permissions)

    switch (spec.kind) {
        case 'always':
            return true
        case 'perm':
            return can(spec.perm)
        case 'anyPerm': {
            // ``canAny`` only checks the global bucket — which is what
            // we want for the sidebar shortcuts. The ``workspaceAny``
            // case below covers the workspace-scoped half explicitly.
            if (canAny(spec.perms)) return true
            // Allow workspace-scoped perms in the list to satisfy via
            // ANY workspace bucket (so "workspace:datasource:manage"
            // in any one ws is enough to show Ingestion). Filter to
            // workspace-prefixed perms only — global ones already
            // checked above.
            for (const p of spec.perms) {
                if (!p.startsWith('workspace:')) continue
                for (const wsId of Object.keys(claims.ws)) {
                    if (checkPermission(claims, p, wsId)) return true
                }
            }
            return false
        }
        case 'workspaceAny': {
            if (claims.global.includes('system:admin')) return true
            if (claims.global.includes('system:org-admin')) return true
            for (const wsId of Object.keys(claims.ws)) {
                if (checkPermission(claims, spec.perm, wsId)) return true
            }
            return false
        }
    }
}
