/**
 * Auth Service — signup, login, and user profile API calls.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const AUTH_API = '/api/v1/auth'
const USERS_API = '/api/v1/users'

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

export interface UserPublicResponse {
    id: string
    email: string
    firstName: string
    lastName: string
    displayName: string
    status: string
    role: string
    createdAt: string
}

export interface LoginResponse {
    accessToken: string
    user: UserPublicResponse
}

// ── HTTP helper (no auth header for public endpoints) ─────────────────

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
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

    login(req: LoginRequest): Promise<LoginResponse> {
        return request<LoginResponse>(`${AUTH_API}/login`, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    getMe(token: string): Promise<UserPublicResponse> {
        return request<UserPublicResponse>(`${USERS_API}/me`, {
            headers: { Authorization: `Bearer ${token}` },
        })
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
