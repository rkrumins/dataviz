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
    role: string
    status: string
    authProvider: string
    createdAt: string
    updatedAt: string
}

/** Backwards-compat alias for components that still import this name. */
export type UserPublicResponse = AuthUser

export interface SessionResponse {
    user: AuthUser
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        let detail = res.statusText
        try {
            const body = JSON.parse(text)
            detail = body.detail || JSON.stringify(body)
        } catch {
            detail = text || res.statusText
        }
        throw new Error(detail)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

// ── Service ───────────────────────────────────────────────────────────

export const authService = {
    signup(req: SignUpRequest): Promise<{ message: string }> {
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
    myPermissions(): Promise<PermissionClaims> {
        return request<PermissionClaims>(`${ME_API}/permissions`)
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

    verifyInvite(token: string): Promise<{ valid: boolean; role: string | null }> {
        return request<{ valid: boolean; role: string | null }>(
            `${AUTH_API}/verify-invite?token=${encodeURIComponent(token)}`,
        )
    },
}
