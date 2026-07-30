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
    type SessionState,
    type SignUpRequest,
} from '@/services/authService'
import {
    clearUserCache,
    readUserCache,
    writeUserCache,
} from '@/store/userCache'
import { resetSessionLostLatch } from '@/services/fetchWithTimeout'
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
 *   * ``loading`` — a resolve is in flight. Only ever entered FROM
 *     ``unknown``: a background re-resolve must never blank a UI that
 *     already knows its claims.
 *   * ``ready``   — we have a definitive answer from the server,
 *     including a legitimately empty claim set (a real state a user can
 *     hold).
 *   * ``error``   — we asked and could not get an answer, and we have no
 *     earlier one to fall back on.
 *
 * ``error`` is the state this type was missing, and its absence is the
 * bug users reported as "it says I don't have permission, then the page
 * loads". A failed resolve used to land on ``ready`` while the claims
 * slice was still empty — indistinguishable, to every guard in the app,
 * from a user who genuinely holds nothing. So one rate-limited or
 * timed-out request on boot painted "You don't have access" over the
 * whole UI, and it stayed until the next poll happened to succeed.
 * Guards now render "couldn't check your access" here, which is both
 * true and recoverable.
 */
export type PermissionsStatus = 'unknown' | 'loading' | 'ready' | 'error'

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
            // ONE call for identity + permissions + expiry. This used to
            // be /auth/me followed by /me/permissions, which could
            // half-succeed four ways; the store had grown a different
            // policy for each. A 401 here still throws, which is the
            // "no session" signal below.
            const state = await authService.session()
            set({ ..._authenticated(state.user), error: null })
            writeUserCache(state.user)
            applyClaims(set, state.permissions)
            // Renew before the token dies rather than discovering it via
            // a 401 fifteen minutes into a page nobody touched.
            onSessionResolved(state)
            // Phase 16: pull the nav catalogue (section→permission map)
            // so the sidebar + route guards read live specs. Awaited:
            // guards gate on it now (a ready claim set plus a seeded
            // catalogue was its own denial flash), and the bundled seed
            // means a failure is still non-fatal.
            await useNavCatalogueStore.getState().hydrate()
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
        resetSessionLostLatch()
        try {
            const { user } = await authService.login({ email, password })
            set({ ..._authenticated(user), error: null, isLoading: false })
            writeUserCache(user)
            await establishSession(set)
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
        resetSessionLostLatch()
        try {
            const { user } = await authService.loginWithBrowserProfile(
                providerSlug, payload,
            )
            set({ ..._authenticated(user), error: null, isLoading: false })
            writeUserCache(user)
            await establishSession(set)
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

    signup: async (req) => {
        set({ error: null, isLoading: true })
        try {
            const resp = await authService.signup(req)
            // Phase 15: an invited signup arrives already authenticated —
            // the response carried the same session cookies /login issues.
            // Run the identical post-login sequence, or the app would be
            // holding a valid session it does not know about.
            if (resp.autoSignedIn && resp.user) {
                resetSessionLostLatch()
                set({ ..._authenticated(resp.user), error: null, isLoading: false })
                writeUserCache(resp.user)
                await establishSession(set)
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
        // family and tombstone the access session. Even if it fails
        // (network down, etc.) we still clear local state — the user is
        // logging out either way.
        try {
            await authService.logout()
        } catch {
            // ignore
        }
        clearUserCache()
        cancelSessionRenewal()
        set({ ..._unauthenticated, error: null, isLoading: false })
    },

    handleSessionLost: () => {
        clearUserCache()
        cancelSessionRenewal()
        set({ ..._unauthenticated, error: null })
    },

    setPermissions: (permissions) => applyClaims(set, permissions),

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
        // Called from outside the login / bootstrap flow: by
        // ``fetchWithTimeout`` after a silent refresh, and by the session
        // poller. ``opts.skipAuthRefresh`` is set on the post-refresh call
        // so it can't recurse into the 401 → refresh loop.
        const state = await resolveSession(set, opts)
        if (state !== null) onSessionResolved(state)
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


/** No global perms AND no workspace scopes: "you can do nothing at all". */
function claimsAreEmpty(claims: PermissionClaims | null | undefined): boolean {
    if (!claims) return true
    return (claims.global?.length ?? 0) === 0
        && Object.keys(claims.ws ?? {}).length === 0
}

/**
 * THE ONLY WRITER OF THE CLAIMS SLICE. Every path goes through here.
 *
 * There used to be three, and they disagreed about the one signal that
 * mattered — a successful response carrying no permissions:
 *
 *   * the poller refused to downgrade a real claim set to nothing;
 *   * ``hydratePermissions`` rotated the token once and then believed it;
 *   * the same function called with ``skipAuthRefresh`` — which is every
 *     post-refresh re-hydrate, so every ~15 minutes — believed it
 *     immediately and blanked the UI.
 *
 * All three were reasonable guesses, because the endpoint they read
 * decoded the access token and could not tell "this user holds nothing"
 * apart from "I couldn't work it out". ``GET /me/session`` resolves from
 * the database, so those are now two different outcomes on the wire: a
 * 200 (however empty) and a thrown error. Which collapses three
 * heuristics into one rule with no guessing in it:
 *
 *   * an answer is trusted, empty or not — the server means it;
 *   * no answer keeps whatever we already knew, and only reports
 *     ``error`` when there was nothing to keep.
 *
 * @param claims the resolved set, or ``null`` for "could not resolve"
 */
function applyClaims(
    set: (partial: Partial<AuthState>) => void,
    claims: PermissionClaims | null,
): void {
    if (claims !== null) {
        set({ permissions: claims, permissionsStatus: 'ready' })
        return
    }
    // Keep the last known-good answer rather than blanking a working UI.
    // Zeroing it here used also to defeat the silent-refresh before/after
    // comparison (empty !== real), firing a blanket cache invalidation on
    // every failed re-resolve — the amplifier behind the app-wide request
    // storm.
    const current = useAuthStore.getState()
    if (!claimsAreEmpty(current.permissions)) {
        set({ permissionsStatus: 'ready' })
        return
    }
    // Nothing known and nothing coming. NOT 'ready': that is what painted
    // "You don't have access" over the whole app after a single failed
    // request on boot. Guards read this as "couldn't check", which is
    // honest and offers a retry instead of an eternal skeleton.
    set({ permissionsStatus: 'error' })
}

/**
 * Resolve the session and apply it. Shared by boot, login and every
 * background re-resolve.
 *
 * ``opts.background`` marks a re-resolve on a session that already knows
 * its claims: it must not drop the guards back to a skeleton, because
 * that would blank a working UI on every routine token rotation.
 */
async function resolveSession(
    set: (partial: Partial<AuthState>) => void,
    opts?: { skipAuthRefresh?: boolean },
): Promise<SessionState | null> {
    if (useAuthStore.getState().permissionsStatus === 'unknown') {
        set({ permissionsStatus: 'loading' })
    }
    let state: SessionState
    try {
        state = await authService.session(opts)
    } catch {
        applyClaims(set, null)
        return null
    }
    // The user DTO rides along, so a rename or a role change lands
    // without a reload and without a second round trip.
    set({ user: state.user })
    writeUserCache(state.user)
    applyClaims(set, state.permissions)
    return state
}

/**
 * Post-sign-in setup, shared by password login, portal login and the
 * auto-signed-in invite path. All three did the same four things in the
 * same order, and the ones that drifted drifted silently.
 */
async function establishSession(
    set: (partial: Partial<AuthState>) => void,
): Promise<void> {
    const state = await resolveSession(set)
    if (state !== null) onSessionResolved(state)
    // Awaited, not fire-and-forget: route guards gate on the catalogue
    // now. The bundled seed keeps a failure non-fatal.
    await useNavCatalogueStore.getState().hydrate()
}

/**
 * Hand a freshly resolved session to the renewal timer, which decides
 * what it implies (renew when, rotate whether) — see
 * ``store/sessionRenewal.ts``.
 *
 * A lazy import so this module does not depend on the timer at load time:
 * ``sessionRenewal`` imports back into the store to re-resolve after a
 * rotation, and tests drive the store without a timer at all.
 */
function onSessionResolved(state: SessionState): void {
    void import('@/store/sessionRenewal')
        .then((mod) => mod.onSessionResolved(state))
        .catch(() => {
            // Without the timer the session still renews reactively on a
            // 401 — the behaviour before renewal was scheduled at all.
        })
}

/** Stop renewing. Used by the logout / session-lost paths. */
function cancelSessionRenewal(): void {
    void import('@/store/sessionRenewal')
        .then((mod) => mod.cancelSessionRenewal())
        .catch(() => {})
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
 *
 * Note this is false in the ``error`` state, which is the point: we asked
 * and got nothing back, so we are not entitled to render a verdict.
 * Guards pair this with {@link usePermissionsUnavailable} to tell
 * "still loading" apart from "couldn't check".
 */
export function usePermissionsReady(): boolean {
    return useAuthStore((s) => s.permissionsStatus === 'ready')
}

/**
 * True when we tried to resolve what this user may do and failed, with
 * no earlier answer to fall back on.
 *
 * Guards render a retry here rather than "You don't have access". The
 * difference is not cosmetic: the old code called this case ``ready``
 * with an empty claim set, so a single rate-limited or timed-out request
 * on boot told the user — in the same words it uses for a real denial —
 * that they had lost access to everything.
 */
export function usePermissionsUnavailable(): boolean {
    return useAuthStore((s) => s.permissionsStatus === 'error')
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
