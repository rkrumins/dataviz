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
    BackchannelLoginError,
    loginWithBackchannel,
    type AuthUser,
    type PermissionClaims,
    type SignUpRequest,
} from '@/services/authService'
import {
    clearUserCache,
    readUserCache,
    writeUserCache,
} from '@/store/userCache'
import {
    ensureCsrfToken,
    resetSessionLostLatch,
    setAuthEnvironmentId,
} from '@/services/fetchWithTimeout'
import type { NavPermissionSpec } from '@/lib/navPermissions'
import { ROLE_NAMES, type RoleName } from '@/lib/roleNames'
import { useNavCatalogueStore } from '@/store/navCatalogue'

export type { PermissionClaims }

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated'

/**
 * Do we yet know what this identity is allowed to do?
 *
 * Orthogonal to ``status``, which only answers "do we have an identity".
 * ``status`` flips to ``authenticated`` from the sessionStorage user
 * cache before any claim has been fetched (see ``store/userCache.ts`` —
 * refusing to cache permissions is deliberate), so a guard reading only
 * the claims slice cannot tell an un-hydrated claim set from a real
 * denial, and flashes "You don't have access" before the content loads.
 *
 *   * ``unknown`` — nothing has been asked yet (also: logged out).
 *   * ``loading`` — a hydrate is in flight. Only ever entered FROM
 *     ``unknown``: a background re-hydrate must never blank a UI that
 *     already knows its claims.
 *   * ``ready``   — we have a definitive answer. Reached on ANY final
 *     one, including a legitimately empty claim set (a real state a
 *     user can hold) and a hydrate that failed after its one recovery
 *     rotation. That is what stops this becoming an eternal spinner.
 */
export type PermissionsStatus = 'unknown' | 'loading' | 'ready'

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
export type SystemRole = RoleName

export const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = {
    [ROLE_NAMES.SUPER_ADMIN]: 'Super Admin',
    [ROLE_NAMES.ORG_ADMIN]: 'Org Admin',
    [ROLE_NAMES.ORG_AUDITOR]: 'Org Auditor',
    [ROLE_NAMES.USER]: 'User',
    [ROLE_NAMES.WORKSPACE_ADMIN]: 'Workspace Admin',
    [ROLE_NAMES.WORKSPACE_DATA_ENGINEER]: 'Data Engineer',
    [ROLE_NAMES.WORKSPACE_MEMBER]: 'Member',
    [ROLE_NAMES.WORKSPACE_VIEWER]: 'Viewer',
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
    if (claims.global.includes('system:admin')) return ROLE_NAMES.SUPER_ADMIN
    if (claims.global.includes('system:org-admin')) return ROLE_NAMES.ORG_ADMIN
    if (!workspaceId) return null
    const bucket = claims.ws[workspaceId]
    if (!bucket) return null
    if (bucket.includes('workspace:admin')) return ROLE_NAMES.WORKSPACE_ADMIN
    // Use wildcard-aware checks so a 'workspace:view:*' / 'workspace:view:edit'
    // claim correctly resolves to "member".
    if (checkPermission(claims, 'workspace:view:edit', workspaceId)) {
        return ROLE_NAMES.WORKSPACE_MEMBER
    }
    if (checkPermission(claims, 'workspace:view:read', workspaceId)) {
        return ROLE_NAMES.WORKSPACE_VIEWER
    }
    return null
}

/** Canonical JSON for a claims object — sorts arrays + object keys so
 *  semantically-equal payloads compare equal regardless of key order
 *  or perm order. Shared cheap change detector for the permission
 *  poller and the silent-refresh path in ``fetchWithTimeout``. */
export function claimsSnapshot(claims: PermissionClaims): string {
    const wsKeys = Object.keys(claims.ws).sort()
    return JSON.stringify({
        global: [...claims.global].sort(),
        ws: wsKeys.reduce<Record<string, string[]>>((acc, k) => {
            acc[k] = [...claims.ws[k]].sort()
            return acc
        }, {}),
    })
}

interface AuthState {
    status: AuthStatus
    /** Convenience derivation of ``status === 'authenticated'``. Kept in
     *  sync on every status change so existing call sites that destructure
     *  ``isAuthenticated`` from the store keep working. */
    isAuthenticated: boolean
    user: AuthUser | null
    permissions: PermissionClaims
    /** Whether ``permissions`` is a known answer yet. Route guards MUST
     *  consult this before rendering a denial — see the type doc. */
    permissionsStatus: PermissionsStatus
    error: string | null
    isLoading: boolean

    /** Call once on app boot — asks the server whether the cookie is valid. */
    bootstrap: () => Promise<void>
    login: (email: string, password: string) => Promise<boolean>
    /** Complete a ``custom_profile`` login from a payload read out of
     *  browser storage. Same post-login hydration as ``login``; only
     *  the endpoint differs. */
    loginWithBrowserProfile: (
        providerSlug: string, payload: string,
    ) => Promise<boolean>
    /** Complete a back-channel login — a handle from the sign-in
     *  trigger, an assertion from the browser exchange, or an empty
     *  body for the ambient-cookie shape. Same post-login hydration as
     *  the other logins; skipping it left the user cache, permissions
     *  and the session-lost latch stale after a gateway sign-in. */
    loginWithBackchannel: (
        providerSlug: string, body: { handle?: string; assertion?: string },
    ) => Promise<boolean>
    /** The last structured SSO refusal, so the sign-in page can explain
     *  it. ``unsafe_auto_link`` suppresses the generic ``error`` — the
     *  collision modal carries that case, and a second banner saying
     *  "did not work" underneath it would just compete. */
    lastSsoDenial: { code: string; email?: string; reasons?: string[] } | null
    signup: (req: SignUpRequest) => Promise<{
        ok: boolean
        message: string
        /** Phase 15: true when the response also established a session.
         *  The caller navigates instead of showing "now sign in". */
        signedIn?: boolean
        redirectTo?: string
    }>
    logout: () => Promise<void>
    /** Internal: invoked by apiClient when a 401 cannot be recovered. */
    handleSessionLost: () => void
    /** Internal: invoked after login / silent refresh hydrates claims. */
    setPermissions: (claims: PermissionClaims) => void
    /** Merge server-confirmed profile fields into the session user, so
     *  the TopBar reflects a rename without a reload. */
    applyProfile: (fields: Partial<AuthUser>) => void
    /** Phase 10: re-fetch ``/me/permissions`` after a silent refresh
     *  so route guards and TopBar react to role / binding mutations
     *  that happened mid-session. Fire-and-forget — failures clear
     *  the claim to empty so guards fail-closed until the next page
     *  load. */
    refreshPermissions: (opts?: { skipAuthRefresh?: boolean }) => Promise<void>
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
    permissionsStatus: 'unknown' as const,
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
    permissionsStatus: 'unknown',
    error: null,
    isLoading: false,
    lastSsoDenial: null,

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
            // ``permissionsStatus`` rides in the SAME set as the status
            // flip. Split across two sets there would be one frame where
            // guards see an identity and 'unknown' claims — which is the
            // flash this exists to remove. Safe to assert 'loading'
            // outright: the early return above means we only get here
            // from 'idle' / 'unauthenticated', both of which are
            // 'unknown'.
            set({
                ..._authenticated(cached),
                permissionsStatus: 'loading',
                error: null,
            })
        } else {
            set({ status: 'loading' })
        }

        try {
            const { user, environment_id } = await authService.me()
            // Before anything schedules a rotation: the keepalive reads
            // an environment-suffixed cookie by name, and reading a
            // sibling deployment's copy would schedule this tab past its
            // own token's expiry. Safe to do here because the keepalive
            // only starts once status flips to 'authenticated', below.
            setAuthEnvironmentId(environment_id)
            // A session can be holding no CSRF cookie — evicted by a
            // sibling deployment's sign-out, cleared by hand, expired —
            // and only a rotation re-mints it. Bootstrap is the one place
            // that knows a session exists before any write is attempted,
            // so repairing here is what makes reloading the page fix it:
            // a reload otherwise changes nothing, because it issues only
            // GETs and no GET needs a CSRF token.
            void ensureCsrfToken()
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
        resetClaimRecovery()
        resetSessionLostLatch()
        try {
            const { user, environment_id } = await authService.login({ email, password })
            setAuthEnvironmentId(environment_id)
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

    loginWithBrowserProfile: async (providerSlug, payload) => {
        set({ error: null, isLoading: true })
        resetClaimRecovery()
        resetSessionLostLatch()
        try {
            const { user } = await authService.loginWithBrowserProfile(
                providerSlug, payload,
            )
            set({ ..._authenticated(user), error: null, isLoading: false })
            writeUserCache(user)
            await hydratePermissions(set)
            void useNavCatalogueStore.getState().hydrate()
            return true
        } catch (err: unknown) {
            const message = err instanceof Error
                ? err.message
                : 'Portal sign-in failed'
            clearUserCache()
            set({ ..._unauthenticated, error: message, isLoading: false })
            return false
        }
    },

    loginWithBackchannel: async (providerSlug, body) => {
        set({ error: null, lastSsoDenial: null, isLoading: true })
        resetClaimRecovery()
        resetSessionLostLatch()
        try {
            const { user } = await loginWithBackchannel(providerSlug, body)
            set({ ..._authenticated(user), error: null, isLoading: false })
            writeUserCache(user)
            await hydratePermissions(set)
            void useNavCatalogueStore.getState().hydrate()
            return true
        } catch (err: unknown) {
            const denial = err instanceof BackchannelLoginError
                ? { code: err.code, email: err.email, reasons: err.reasons }
                : null
            const message = err instanceof Error
                ? err.message
                : 'Gateway sign-in failed'
            clearUserCache()
            set({
                ..._unauthenticated,
                // The collision modal owns unsafe_auto_link; a generic
                // banner under it would compete with the explanation.
                error: denial?.code === 'unsafe_auto_link' ? null : message,
                lastSsoDenial: denial,
                isLoading: false,
            })
            return false
        }
    },

    signup: async (req) => {
        set({ error: null, isLoading: true })
        try {
            const resp = await authService.signup(req)
            // Phase 15: an invited signup arrives already authenticated —
            // the response carried the same session cookies /login issues.
            // Run the identical post-login sequence, or the app would be
            // holding a valid session it does not know about.
            if (resp.autoSignedIn && resp.user) {
                resetClaimRecovery()
                resetSessionLostLatch()
                set({ ..._authenticated(resp.user), error: null, isLoading: false })
                writeUserCache(resp.user)
                await hydratePermissions(set)
                void useNavCatalogueStore.getState().hydrate()
                return {
                    ok: true,
                    message: resp.message,
                    signedIn: true,
                    redirectTo: resp.redirectTo ?? '/',
                }
            }
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
        resetClaimRecovery()
        set({ ..._unauthenticated, error: null, isLoading: false })
        // Other tabs share the cookie jar, so their session is gone too —
        // they just don't know it yet. Told directly, they sign out now
        // instead of discovering it on their next request.
        void (async () => {
            try {
                const mod = await import('@/store/permissionChangeBus')
                mod.notifySignedOut()
            } catch {
                // best-effort
            }
        })()
    },

    handleSessionLost: () => {
        clearUserCache()
        resetClaimRecovery()
        set({ ..._unauthenticated, error: null })
    },

    setPermissions: (permissions) =>
        set({ permissions, permissionsStatus: 'ready' }),

    applyProfile: (fields) => {
        const user = get().user
        if (!user) return
        // Merge rather than replace. The profile endpoint returns a
        // narrower shape than AuthUser — no authProvider — and
        // ``userCache._isValidUser`` requires that field. Writing the
        // response through verbatim would produce a cache entry that
        // fails validation on the next read, get silently wiped, and
        // bring back the blank-shell flash on reload.
        const next = { ...user, ...fields }
        set({ user: next })
        writeUserCache(next)
    },

    refreshPermissions: async (opts) => {
        // Mirrors ``hydratePermissions`` but called from outside the
        // login / bootstrap flow. Used by ``fetchWithTimeout`` after
        // a successful silent refresh — the new JWT carries
        // re-resolved claims (auth_service/service.py:365) and the
        // FE store needs to catch up so route guards stop blocking
        // a freshly-promoted admin. ``opts.skipAuthRefresh`` is set on
        // that post-refresh call so it can't recurse into the loop.
        await hydratePermissions(set, opts)
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
/** No global perms AND no workspace scopes: "you can do nothing at all". */
function claimsAreEmpty(claims: PermissionClaims | null | undefined): boolean {
    if (!claims) return true
    return (claims.global?.length ?? 0) === 0
        && Object.keys(claims.ws ?? {}).length === 0
}

/**
 * One-shot per page load. A claimless token is a property of the SESSION, not of
 * the request, so retrying on every hydrate would be a rotation storm.
 */
let claimRecoveryAttempted = false

/** Called on login/logout: a new session deserves a fresh attempt. */
export function resetClaimRecovery(): void {
    claimRecoveryAttempted = false
}

async function hydratePermissions(
    set: (partial: Partial<AuthState>) => void,
    opts?: { skipAuthRefresh?: boolean },
): Promise<void> {
    // Only ever 'unknown' → 'loading'. A background re-hydrate on a
    // session that already knows its claims must not send the guards
    // back to a skeleton — same principle as the catch block below and
    // as permissionPoller's empty-claims guard.
    if (useAuthStore.getState().permissionsStatus === 'unknown') {
        set({ permissionsStatus: 'loading' })
    }
    try {
        let claims = await authService.myPermissions(opts)

        // SELF-HEAL A CLAIMLESS TOKEN.
        //
        // `/me/permissions` DECODES THE ACCESS JWT — it does not consult the
        // database. So a token that carries no permission claims produces an empty
        // set with a 200, not a 401: the backend's own note says such tokens "still
        // authenticate (via the legacy role claim) and the user simply has no
        // permissions until their next login."
        //
        // "Until their next login" is the bug. The user is left with every
        // permission-gated control silently missing — the Create Workspace button,
        // the provider and ontology summaries, the schema chips — and no reload can
        // fix it, because a reload reuses the same cookie. Logging out and back in
        // was the only cure, and that is exactly what a user reported.
        //
        // Rotating the token is the same cure without the ceremony: /auth/refresh
        // re-resolves claims from the DB and mints a new access token, so one
        // rotation restores the session in place.
        //
        // Guarded on `skipAuthRefresh` because that flag marks the call that ALREADY
        // came from a refresh — rotating again there would loop.
        if (claimsAreEmpty(claims) && !claimRecoveryAttempted && !opts?.skipAuthRefresh) {
            claimRecoveryAttempted = true
            try {
                await authService.refresh()
                claims = await authService.myPermissions({ skipAuthRefresh: true })
            } catch {
                // Rotation failed (or the session really is gone). Fall through with
                // what we have: a user who genuinely holds no permissions is a real,
                // legitimate state, and must not be mistaken for a broken one.
            }
        }

        set({ permissions: claims, permissionsStatus: 'ready' })
    } catch {
        // 'ready' even here: this is the final answer available for this
        // page load (the one recovery rotation above is already spent),
        // and a guard that waits forever for an answer that is not
        // coming is an eternal spinner, not a safer UI.
        set({ permissionsStatus: 'ready' })
        // Keep the previous claims on a transient failure. Zeroing them
        // to EMPTY here used to defeat the silent-refresh before/after
        // guard (empty !== real), firing a blanket cache invalidation on
        // every failed re-hydrate — the amplifier behind the app-wide
        // request storm. A genuine revocation arrives as a 200 with
        // reduced claims and still updates correctly above; an outage now
        // leaves the last-known claims in place instead of blanking the UI.
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

/**
 * True once the claims are a known answer. Route guards render a
 * skeleton until this flips — an un-hydrated claim set is not a denial.
 */
export function usePermissionsReady(): boolean {
    return useAuthStore((s) => s.permissionsStatus === 'ready')
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
    const claims = useAuthStore((s) => s.permissions)
    return checkNavPermission(claims, spec)
}

/**
 * The same question, outside a hook.
 *
 * Extracted because callers exist that must ask it for a LIST of specs — the
 * Analytics insight strip decides per finding whether the screen that fixes it
 * is reachable — and a hook cannot be called in a loop. Duplicating the switch
 * would let the sidebar and those callers drift apart, which is the one thing
 * this file exists to prevent.
 */
export function checkNavPermission(
    claims: PermissionClaims, spec: NavPermissionSpec,
): boolean {
    const can = (perm: string, workspaceId?: string | null) =>
        checkPermission(claims, perm, workspaceId)
    const canAny = (perms: string[]) => perms.some((p) => can(p))

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
