/**
 * Auth Service — public auth endpoints.
 *
 * The session lives in HttpOnly cookies set by the backend, so every
 * call here uses ``credentials: 'include'`` to ferry them. No tokens
 * are ever read or sent by JavaScript — the cookie is invisible to us
 * by design, which is what closes the localStorage XSS hole.
 *
 * None of these endpoints are CSRF-gated (login/logout/refresh/signup/
 * password-reset/verify-invite are all on the middleware's exempt list,
 * and ``GET /me`` is a safe method), so this module doesn't need to
 * forward the ``X-CSRF-Token`` header. The general apiClient does.
 */

import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

const AUTH_API = '/api/v1/auth'
const ME_API = '/api/v1/me'

// ── Types ─────────────────────────────────────────────────────────────

export interface SignUpRequest {
    email: string
    password: string
    firstName: string
    lastName: string
    inviteToken?: string
}

export interface LoginRequest {
    email: string
    password: string
}

/** Cross-service identity DTO — mirrors ``backend.auth_service.interface.User``. */
export interface AuthUser {
    id: string
    email: string
    firstName: string
    lastName: string
    /** Resolved server-side: the chosen name, or first + last. */
    displayName?: string
    role: string
    status: string
    authProvider: string
    createdAt: string
    updatedAt: string
    /** Chosen avatar illustration, or null for the initials fallback. */
    avatarId?: string | null
    /** True while the account must rotate its password before it can do
     *  anything else. The API refuses everything but the change screen. */
    mustChangePassword?: boolean
    /** IdP-mapped extras (department, employee_id, …). Phase 3. */
    attributes?: Record<string, unknown>
}

/** Public summary of one configured SSO provider — returned by
 *  ``GET /auth/providers``. No secrets. */
export interface SsoProviderSummary {
    id: string
    slug: string
    displayName: string
    kind: string                 // 'oidc' | 'saml2' | 'custom' | 'custom_profile'
    priority: number
    buttonLabel?: string | null
    buttonIcon?: string | null
    /** Non-secret, per-kind hints needed to start the flow. Only
     *  ``custom_profile`` populates it today: ``source`` always, plus
     *  ``sourceKey`` when the payload lives in browser storage and the
     *  client is the one that has to read it. */
    config?: {
        source?: string
        sourceKey?: string
    }
}

/** What the login page needs to pick its shape.
 *
 *  ``allowLocalLogin`` off means the password form must not render at all
 *  — the server refuses it, so offering it is offering a dead control.
 *  ``emailFirstLogin`` on means route by email domain instead of showing
 *  every provider as a button. */
export interface LoginContext {
    allowLocalLogin: boolean
    emailFirstLogin: boolean
    providers: SsoProviderSummary[]
}

/** Sources whose payload only JavaScript can reach — cookie and header
 *  sources are read server-side and complete as a plain redirect. */
export const BROWSER_STORAGE_SOURCES = ['local_storage', 'session_storage']

/** True when this provider needs the client to read a storage key and
 *  POST it, rather than just following ``/auth/{slug}/login``. */
export function needsBrowserPayload(p: SsoProviderSummary): boolean {
    return (
        p.kind === 'custom_profile' &&
        BROWSER_STORAGE_SOURCES.includes(p.config?.source ?? '')
    )
}

/** Read a custom-profile payload out of the browser store the provider
 *  is configured against. Returns null when the key is absent — that
 *  means "no portal session here", not an error. */
export function readBrowserProfile(p: SsoProviderSummary): string | null {
    const key = p.config?.sourceKey
    if (!key) return null
    try {
        const store = p.config?.source === 'session_storage'
            ? window.sessionStorage
            : window.localStorage
        return store.getItem(key)
    } catch {
        // Storage can throw in private-mode / blocked-cookie browsers.
        return null
    }
}

/** One linked identity on the current user. */
export interface UserIdentity {
    id: string
    provider: {
        id: string
        slug: string
        displayName: string
        kind: string
    }
    externalId: string
    emailAtLink?: string | null
    createdAt: string
    lastLoginAt?: string | null
}

export interface IdentitiesResponse {
    passwordSet: boolean
    identities: UserIdentity[]
}

/** Backwards-compat alias for components that still import this name. */
export type UserPublicResponse = AuthUser

export interface SessionResponse {
    user: AuthUser
    /** Which deployment answered. Suffixes the cookie names the client
     *  has to read by name — see ``setAuthEnvironmentId``. Absent when
     *  the backend sets no ``AUTH_ENVIRONMENT_ID``, which is also when
     *  those names are unscoped. */
    environment_id?: string | null
}

/**
 * Permission claims for the current session. Mirrors the JWT claim
 * embedded by the backend — same shape, same field names.
 *
 * Lives in this module rather than the store so other services can
 * import it without dragging the Zustand machinery along, and so the
 * store → service direction of imports stays one-way.
 */
export interface PermissionClaims {
    sid: string
    global: string[]
    ws: Record<string, string[]>
}

// ── HTTP helper ───────────────────────────────────────────────────────

async function request<T>(url: string, init?: RequestInit & { skipAuthRefresh?: boolean }): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        // Use the shared extractor so the structured permission /
        // validation error envelopes land as readable strings instead
        // of "[object Object]" via ``new Error(dict)`` coercion.
        const detail = extractErrorMessageFromText(text, res.statusText)
        throw new Error(detail)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

// ── Service ───────────────────────────────────────────────────────────

export const authService = {
    signup(req: SignUpRequest): Promise<{
        message: string
        /** Phase 15: an invited signup comes back already signed in —
         *  session cookies are on this response. The invitee was
         *  pre-approved by the invite, so a second credential
         *  round-trip buys nothing. */
        autoSignedIn?: boolean
        user?: AuthUser | null
        redirectTo?: string | null
    }> {
        return request<{ message: string }>(`${AUTH_API}/signup`, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    login(req: LoginRequest): Promise<SessionResponse> {
        return request<SessionResponse>(`${AUTH_API}/login`, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    /** Validate the access cookie and return the current user. */
    me(): Promise<SessionResponse> {
        return request<SessionResponse>(`${AUTH_API}/me`)
    },

    /**
     * Fetch the caller's effective permissions (decoded JWT claims).
     *
     * Used by the auth store on bootstrap and after login to hydrate
     * the permission slice that drives ``<RequirePermission>`` and the
     * ``can()`` helpers.
     */
    myPermissions(opts?: { skipAuthRefresh?: boolean }): Promise<PermissionClaims> {
        // skipAuthRefresh is passed by the post-refresh re-hydrate so this
        // call can't recurse back into the silent-refresh loop.
        return request<PermissionClaims>(`${ME_API}/permissions`, opts)
    },

    /** Revoke the refresh-token family and clear cookies. Idempotent. */
    logout(): Promise<{ ok: boolean }> {
        return request<{ ok: boolean }>(`${AUTH_API}/logout`, { method: 'POST' })
    },

    /** Rotate access + refresh cookies. Used by apiClient on 401. */
    refresh(): Promise<SessionResponse> {
        return request<SessionResponse>(`${AUTH_API}/refresh`, { method: 'POST' })
    },

    forgotPassword(email: string): Promise<{ message: string }> {
        return request<{ message: string }>(`${AUTH_API}/forgot-password`, {
            method: 'POST',
            body: JSON.stringify({ email }),
        })
    },

    resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
        return request<{ message: string }>(`${AUTH_API}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ token, newPassword }),
        })
    },

    verifyInvite(token: string): Promise<{
        valid: boolean
        role: string | null
        workspaceId?: string | null
        workspaceName?: string | null
        email?: string | null
        /** Phase 13: groups attached on signup. ``groupIds`` mirrors
         *  the token payload; ``groupNames`` is resolved server-side
         *  so the banner can show friendly names. */
        groupIds?: string[] | null
        groupNames?: string[] | null
        /** Phase 15: why an unusable link is unusable. "Invalid or
         *  expired" covered four situations with four different
         *  remedies, and only one of them is "ask for a new link". */
        reason?:
            | 'expired' | 'revoked' | 'exhausted'
            | 'domain_mismatch' | 'links_disabled' | 'invalid'
            | null
        /** Phase 15: seats left on a capped link (null = uncapped) and
         *  when it stops working, so the page can show the limits up
         *  front instead of only on a failed submit. */
        seatsRemaining?: number | null
        expiresAt?: string | null
    }> {
        return request(
            `${AUTH_API}/verify-invite?token=${encodeURIComponent(token)}`,
        )
    },

    // ── SSO discovery + self-service identities (Phase 3) ───────────

    /**
     * Route an email address to its IdP (Home Realm Discovery).
     *
     * Returns ``null`` for every miss — feature off, unknown domain,
     * disabled provider — so the caller cannot use it to enumerate which
     * domains an org has configured.
     */
    resolveEmailDomain(email: string): Promise<{ provider: SsoProviderSummary | null }> {
        return request<{ provider: SsoProviderSummary | null }>(
            `${AUTH_API}/resolve`,
            { method: 'POST', body: JSON.stringify({ email }) },
        )
    },

    /** Public catalog of enabled SSO providers. Returns ``[]`` when the
     *  registry is unconfigured.
     *
     *  The login page uses {@link loginContext} instead — it needs the
     *  posture in the same round trip to know what to render. */
    listProviders(): Promise<SsoProviderSummary[]> {
        return request<SsoProviderSummary[]>(`${AUTH_API}/providers`)
    },

    /** Catalog + platform posture, for deciding the login page's shape
     *  before first paint. */
    loginContext(): Promise<LoginContext> {
        return request<LoginContext>(`${AUTH_API}/login-context`)
    },

    /**
     * Complete a ``custom_profile`` login from a payload the browser
     * read out of local/sessionStorage.
     *
     * A fetch rather than a top-level navigation because only JS can
     * reach web storage; the session cookies ride back on the response
     * and the caller navigates itself. The payload is opaque to us —
     * signature and freshness are checked server-side.
     */
    loginWithBrowserProfile(
        providerSlug: string, payload: string,
    ): Promise<SessionResponse> {
        return request<SessionResponse>(
            `${AUTH_API}/${encodeURIComponent(providerSlug)}/browser-profile`,
            { method: 'POST', body: JSON.stringify({ payload }) },
        )
    },

    /** Apply an invite to the already-signed-in user. The SSO route
     *  into an invitation: the provider handshake authenticates them,
     *  this grants what the link carried. */
    redeemInvite(inviteToken: string): Promise<{
        applied: boolean
        message: string
        role?: string | null
        workspaceId?: string | null
        redirectTo: string
    }> {
        return request(`${AUTH_API}/redeem-invite`, {
            method: 'POST',
            body: JSON.stringify({ inviteToken }),
        })
    },

    /** Logged-in user's linked SSO identities + whether they have a
     *  password set. Drives ``/me/identities`` page. */
    listMyIdentities(): Promise<IdentitiesResponse> {
        return request<IdentitiesResponse>('/api/v1/me/identities')
    },

    /** Self-service unlink. Server returns 409 when this would leave
     *  the user without any authenticator. */
    unlinkMyIdentity(identityId: string): Promise<void> {
        return request<void>(
            `/api/v1/me/identities/${encodeURIComponent(identityId)}`,
            { method: 'DELETE' },
        )
    },

    /** Begin a self-service link flow. Returns the IdP login URL to
     *  navigate to; the cookie set on this call carries the link-
     *  intent so the SSO callback binds the new identity to the
     *  current user instead of provisioning a fresh one. */
    startIdentityLink(providerSlug: string): Promise<{
        loginUrl: string
        providerSlug: string
        providerKind: string
    }> {
        return request<{
            loginUrl: string
            providerSlug: string
            providerKind: string
        }>(
            `/api/v1/me/identities/link/${encodeURIComponent(providerSlug)}/start`,
            { method: 'POST' },
        )
    },
}
