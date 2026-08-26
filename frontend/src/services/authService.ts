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
    /** Non-secret, per-kind hints needed to start the flow.
     *
     *  ``custom_profile``: ``source`` always, plus ``sourceKey`` when the
     *  payload lives in browser storage and the client has to read it.
     *
     *  ``backchannel``: the four ``authenticate*`` keys when a sign-in
     *  trigger is configured, and the four ``browserExchange*`` keys
     *  when the row's exchange runs in the browser — that is the
     *  translate call the browser itself must make, so its shape is
     *  public by design. The server whitelists all of these by name —
     *  the settings blob they come from also holds the server-side
     *  endpoint URLs and their credentials, none of which appear here. */
    config?: {
        source?: string
        authenticateUrl?: string
        authenticateMethod?: string
        authenticateHeaders?: Record<string, string>
        authenticateTokenPath?: string
        browserExchangeUrl?: string
        browserExchangeMethod?: string
        browserExchangeHeaders?: Record<string, string>
        browserExchangeTokenPath?: string
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

/** True when the sign-in button must leave this origin for the IdP.
 *
 *  Only OIDC and SAML do. A back-channel provider does its whole
 *  exchange server-side, and a cookie- or header-sourced corporate
 *  portal is read on the request — both land the user straight back
 *  here. The button's affordance follows this, because promising a
 *  hand-off that never happens is worse than a plain chevron. */
export function leavesForIdp(p: SsoProviderSummary): boolean {
    return p.kind === 'oidc' || p.kind === 'saml2'
}

/** True when signing in has to start with a call to the provider's own
 *  authenticate endpoint before we can do anything.
 *
 *  This is the Kerberos/SPNEGO case, and the call CANNOT be made by our
 *  server. The provider answers with `401 WWW-Authenticate: Negotiate`;
 *  answering that needs a Service Ticket from the workstation's OS
 *  credential store, which only the browser can obtain — via SSPI on
 *  Windows, GSS-API elsewhere. `credentials: 'include'` is what lets the
 *  browser do it, and the retry is automatic and invisible to us. */
export function needsAuthenticateFirst(p: SsoProviderSummary): boolean {
    return Boolean(p.config?.authenticateUrl)
}

/** Run that call.
 *
 *  Returns the handle when the provider answers with one, or null when
 *  it works by setting a cookie — both are success. Throws only when the
 *  call itself failed, so the caller can say so instead of navigating
 *  into a sign-in that was never going to work.
 *
 *  Nothing here inspects the handle. It goes straight back to the
 *  provider's own gateway, which is the only party that can say what it
 *  means — see the note on `POST /auth/{slug}/backchannel`. */
export async function runAuthenticateTrigger(
    p: SsoProviderSummary,
): Promise<string | null> {
    return runAuthenticateCall({
        url: p.config?.authenticateUrl as string,
        method: p.config?.authenticateMethod as string,
        headers: p.config?.authenticateHeaders,
        tokenPath: p.config?.authenticateTokenPath as string,
    })
}

/** The same call, from a provider's raw settings rather than its public
 *  config.
 *
 *  The admin surfaces hold the settings blob, not the sign-in page's
 *  view of it, and they need this too: rehearsing a connection opens a
 *  tab that would arrive with no session at all unless the trigger has
 *  run first. Same call, two callers, one implementation — the
 *  alternative was an admin rehearsal that failed for a correctly
 *  configured gateway and gave no reason why. */
/** How long the browser waits on the provider's own authenticate (and
 *  translate) endpoints. Generous — a Negotiate round trip can involve a
 *  KDC — but bounded, so a dead endpoint fails the attempt instead of
 *  leaving the login page silently stuck. */
export const AUTHENTICATE_TIMEOUT_MS = 10_000

export async function runAuthenticateCall(cfg: {
    url?: string
    method?: string
    headers?: Record<string, string>
    tokenPath?: string
}): Promise<string | null> {
    const url = cfg.url as string
    const method = cfg.method || 'POST'
    const headers = (cfg.headers ?? {}) as Record<string, string>
    const tokenPath = cfg.tokenPath || ''

    // Raw fetch on purpose (cross-origin, no CSRF, no refresh-on-401) —
    // but that also means no timeout unless we bring one. A hung
    // corporate endpoint must not hang the silent sign-in forever.
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), AUTHENTICATE_TIMEOUT_MS)
    let res: Response
    try {
        res = await fetch(url, {
            method,
            headers,
            // The whole point. Without it the browser neither sends the
            // provider's existing cookies nor offers to answer a Negotiate
            // challenge from the OS.
            credentials: 'include',
            signal: abort.signal,
        })
    } catch (err) {
        if (abort.signal.aborted) {
            throw new Error('The sign-in service did not answer in time.')
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
    if (!res.ok) {
        throw new Error(`The sign-in service answered ${res.status}.`)
    }
    if (!tokenPath) return null

    let body: unknown
    try {
        body = await res.json()
    } catch {
        throw new Error('The sign-in service did not return JSON.')
    }
    const handle = resolvePath(body, tokenPath)
    if (typeof handle !== 'string' || !handle) {
        throw new Error(
            `The sign-in service returned no value at "${tokenPath}".`,
        )
    }
    return handle
}

/** Walk a dotted/indexed path, mirroring what the server does with the
 *  gateway and claims paths so an operator configures one syntax. */
function resolvePath(value: unknown, path: string): unknown {
    let cur: unknown = value
    for (const seg of path.split('.')) {
        const m = /^([^[\]]*)((\[\d+\])*)$/.exec(seg)
        if (!m) return undefined
        if (m[1]) {
            if (!cur || typeof cur !== 'object') return undefined
            cur = (cur as Record<string, unknown>)[m[1]]
        }
        for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
            if (!Array.isArray(cur)) return undefined
            cur = cur[Number(idx[1])]
        }
    }
    return cur
}

/** True when the row's exchange runs in the browser: the corporate
 *  cookie is scoped to the SSO host, so only this browser's cookie jar
 *  can present it to the translate endpoint. The server publishes the
 *  call's shape for exactly this case. */
export function needsBrowserExchange(p: SsoProviderSummary): boolean {
    return Boolean(p.config?.browserExchangeUrl)
}

/** Run the browser-side translate call and return the JWT it answered
 *  with.
 *
 *  Same posture as the authenticate trigger: raw fetch (cross-origin,
 *  no CSRF, no refresh-on-401), `credentials: 'include'` so the
 *  corporate cookie rides along, and a timeout of our own. The token is
 *  read from `browserExchangeTokenPath`, or the whole body when the
 *  path is blank — the bare `application/jwt` shape. Nothing here
 *  decodes it; the server verifies it against the connection's JWKS. */
export async function runBrowserExchange(
    p: SsoProviderSummary,
): Promise<string> {
    return runBrowserExchangeCall({
        url: p.config?.browserExchangeUrl as string,
        method: p.config?.browserExchangeMethod as string,
        headers: p.config?.browserExchangeHeaders,
        tokenPath: p.config?.browserExchangeTokenPath as string,
    })
}

/** The same call, from a provider's raw settings rather than its public
 *  config — the admin rehearsal surfaces hold the settings blob, and
 *  rehearsing a browser-mode row means making the very call the sign-in
 *  page would make. Same call, two callers, one implementation. */
export async function runBrowserExchangeCall(cfg: {
    url?: string
    method?: string
    headers?: Record<string, string>
    tokenPath?: string
}): Promise<string> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), AUTHENTICATE_TIMEOUT_MS)
    let res: Response
    try {
        res = await fetch(cfg.url as string, {
            method: cfg.method || 'GET',
            headers: cfg.headers ?? {},
            credentials: 'include',
            signal: abort.signal,
        })
    } catch (err) {
        if (abort.signal.aborted) {
            throw new Error('The sign-in service did not answer in time.')
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
    if (!res.ok) {
        throw new Error(`The sign-in service answered ${res.status}.`)
    }

    const path = cfg.tokenPath || ''
    let token: unknown
    if (path) {
        let body: unknown
        try {
            body = await res.json()
        } catch {
            throw new Error('The sign-in service did not return JSON.')
        }
        token = resolvePath(body, path)
    } else {
        token = (await res.text()).trim()
        // A translate endpoint answering JSON with a blank path is a
        // configuration mismatch; a quoted string still reads cleanly.
        if (typeof token === 'string' && token.startsWith('"')) {
            try { token = JSON.parse(token) } catch { /* keep the text */ }
        }
    }
    if (typeof token !== 'string' || !token) {
        throw new Error(
            path
                ? `The sign-in service returned no value at "${path}".`
                : 'The sign-in service returned an empty reply.',
        )
    }
    return token
}

/** A back-channel sign-in the server refused, with the structure it
 *  refused it in. ``code`` is the backend's error vocabulary; for
 *  ``unsafe_auto_link`` the colliding ``email`` and the ``reasons``
 *  that refused the link ride along, so the sign-in page can explain
 *  the collision instead of shrugging. The message stays generic — it
 *  is what generic error surfaces render. */
export class BackchannelLoginError extends Error {
    code: string
    email?: string
    reasons?: string[]

    constructor(
        code: string, opts: { email?: string; reasons?: string[] } = {},
    ) {
        super('Signing in with that session did not work.')
        this.name = 'BackchannelLoginError'
        this.code = code
        this.email = opts.email
        this.reasons = opts.reasons
    }
}

/** Complete a back-channel sign-in. The body picks the shape: a handle
 *  from the trigger, an assertion from the browser exchange, or nothing
 *  at all — the server-mode JSON entry that reads the ambient cookie
 *  off this very request. Returns the session payload so callers can
 *  hydrate state without a second round trip; a refusal throws
 *  {@link BackchannelLoginError} carrying the server's structured
 *  detail. */
export async function loginWithBackchannel(
    slug: string,
    body: { handle?: string; assertion?: string },
    opts: { skipAuthRefresh?: boolean } = {},
): Promise<SessionResponse> {
    const res = await fetchWithTimeout(
        `/api/v1/auth/${encodeURIComponent(slug)}/backchannel`,
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            skipAuthRefresh: opts.skipAuthRefresh ?? false,
        },
    )
    if (!res.ok) {
        type DenialDetail = { error?: string; email?: string; reasons?: string[] }
        let detail: DenialDetail | null = null
        try {
            const parsed = (await res.json()) as { detail?: DenialDetail }
            detail = parsed?.detail ?? null
        } catch {
            // Not a JSON body — the code below still says which layer.
        }
        throw new BackchannelLoginError(
            detail?.error ?? `http_${res.status}`,
            {
                email: detail?.email,
                reasons: Array.isArray(detail?.reasons)
                    ? detail.reasons.map(String)
                    : undefined,
            },
        )
    }
    return res.json() as Promise<SessionResponse>
}

/** Complete a back-channel sign-in with a handle the trigger returned. */
export async function loginWithBackchannelHandle(
    slug: string, handle: string,
): Promise<void> {
    await loginWithBackchannel(slug, { handle })
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
