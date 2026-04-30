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
 * Check a single permission against the claim. Mirrors the server-side
 * ``has_permission`` exactly — wildcard expansion (``workspace:view:*``)
 * and global ``system:admin`` implicit-allow are honoured.
 *
 * @param permission e.g. ``"workspace:view:edit"`` or ``"workspaces:create"``
 * @param workspaceId required for workspace-scoped permissions; pass
 *   undefined for global ones.
 */
export function checkPermission(
    claims: PermissionClaims,
    permission: string,
    workspaceId?: string | null,
): boolean {
    // Global admin shortcut.
    if (claims.global.includes('system:admin')) return true

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
        set({ status: 'loading' })
        try {
            const { user } = await authService.me()
            set({ ..._authenticated(user), error: null })
            // Hydrate permissions in the background — failure here
            // doesn't unauthenticate the user, it just means the FE
            // gates fall closed until next refresh.
            await hydratePermissions(set)
        } catch {
            // Any failure (no cookie, expired, server down) → unauthenticated.
            // The user lands on /login; route guards do the rest.
            set({ ..._unauthenticated, error: null })
        }
    },

    login: async (email, password) => {
        set({ error: null, isLoading: true })
        try {
            const { user } = await authService.login({ email, password })
            set({ ..._authenticated(user), error: null, isLoading: false })
            await hydratePermissions(set)
            return true
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Login failed'
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
        set({ ..._unauthenticated, error: null, isLoading: false })
    },

    handleSessionLost: () => {
        set({ ..._unauthenticated, error: null })
    },

    setPermissions: (permissions) => set({ permissions }),

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
