/**
 * sessionStorage cache for the authenticated User DTO.
 *
 * Purpose: skip the 50-200ms "blank shell" flash on reloads within a
 * tab by seeding ``useAuthStore`` synchronously from a cached copy of
 * the last successful ``GET /auth/me`` response. The cache is ONLY a
 * render seed — every bootstrap still calls ``/auth/me`` and replaces
 * (or wipes) the cache based on the server's answer. The cookie
 * remains the single source of truth.
 *
 * Why sessionStorage, not localStorage:
 *   - sessionStorage clears on tab close, so a logged-out user never
 *     leaves identity data on disk.
 *   - It is not shared across tabs, so a logout in tab A cannot
 *     orphan the cache in tab B (and tab B's next request will 401
 *     and clear its own cache).
 *   - It survives ``location.reload()`` and route navigations — the
 *     case we are optimising — without surviving cookie expiry across
 *     a restart.
 *
 * What is NOT cached: tokens (HttpOnly cookies), CSRF, or permission
 * claims. Permissions are re-resolved on every boot so a role
 * demotion or group change between sessions never renders with stale
 * gating.
 */

import type { AuthUser } from '@/services/authService'

const STORAGE_KEY = 'nx_user_v1'

// Bump the schema version when the AuthUser shape changes in a way
// that an old cache could mis-populate the store. Stored entries with
// a different ``_v`` are treated as a miss.
const SCHEMA_VERSION = 1

interface CacheEnvelope {
    _v: number
    user: AuthUser
}

function _storage(): Storage | null {
    // Private-browsing on some browsers, SSR, and tests-without-DOM
    // all cause ``sessionStorage`` to be unavailable or throw on
    // access. A missing cache MUST never crash the boot.
    if (typeof window === 'undefined') return null
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

function _isValidUser(value: unknown): value is AuthUser {
    if (!value || typeof value !== 'object') return false
    const u = value as Record<string, unknown>
    const required = [
        'id', 'email', 'firstName', 'lastName',
        'role', 'status', 'authProvider',
    ] as const
    for (const key of required) {
        if (typeof u[key] !== 'string' || (u[key] as string).length === 0) {
            return false
        }
    }
    // createdAt / updatedAt are best-effort strings; allow empty.
    if ('createdAt' in u && typeof u.createdAt !== 'string') return false
    if ('updatedAt' in u && typeof u.updatedAt !== 'string') return false
    return true
}

/**
 * Synchronously return the cached User DTO if one is present, the
 * schema version matches, and the shape validates. Returns ``null``
 * for any other case (and silently wipes the bad entry so the next
 * write starts clean).
 */
export function readUserCache(): AuthUser | null {
    const s = _storage()
    if (s === null) return null
    let raw: string | null
    try {
        raw = s.getItem(STORAGE_KEY)
    } catch {
        return null
    }
    if (!raw) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        // Corrupted JSON — wipe it so the next write starts clean.
        clearUserCache()
        return null
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || (parsed as CacheEnvelope)._v !== SCHEMA_VERSION
        || !_isValidUser((parsed as CacheEnvelope).user)
    ) {
        clearUserCache()
        return null
    }
    return (parsed as CacheEnvelope).user
}

/**
 * Write the user DTO to sessionStorage. Wraps in the version-tagged
 * envelope so a future schema bump invalidates old entries
 * automatically. Storage exceptions (quota, private mode) are
 * swallowed — caching is best-effort by design.
 */
export function writeUserCache(user: AuthUser): void {
    const s = _storage()
    if (s === null) return
    try {
        s.setItem(
            STORAGE_KEY,
            JSON.stringify({ _v: SCHEMA_VERSION, user } satisfies CacheEnvelope),
        )
    } catch {
        // Quota exceeded, private-mode rejection, etc. Render flash
        // is a UX hit, not a security one — fall through silently.
    }
}

/**
 * Remove the cached user. Called from every code path that drops
 * in-memory auth state (logout, session-lost, SSO re-auth bounce).
 */
export function clearUserCache(): void {
    const s = _storage()
    if (s === null) return
    try {
        s.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
}
