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
import { authService, type AuthUser, type SignUpRequest } from '@/services/authService'
import { disableProviderStatusPolling } from '@/store/providerStatus'
import { disableProviderHealthPolling } from '@/store/providerHealth'

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated'

interface AuthState {
    status: AuthStatus
    /** Convenience derivation of ``status === 'authenticated'``. Kept in
     *  sync on every status change so existing call sites that destructure
     *  ``isAuthenticated`` from the store keep working. */
    isAuthenticated: boolean
    user: AuthUser | null
    error: string | null
    isLoading: boolean

    /** Call once on app boot — asks the server whether the cookie is valid. */
    bootstrap: () => Promise<void>
    login: (email: string, password: string) => Promise<boolean>
    signup: (req: SignUpRequest) => Promise<{ ok: boolean; message: string }>
    logout: () => Promise<void>
    /** Internal: invoked by apiClient when a 401 cannot be recovered. */
    handleSessionLost: () => void
    clearError: () => void
}

const _unauthenticated = {
    status: 'unauthenticated' as const,
    isAuthenticated: false,
    user: null,
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
        disableProviderStatusPolling()
        disableProviderHealthPolling()
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
        disableProviderStatusPolling()
        disableProviderHealthPolling()
        set({ ..._unauthenticated, error: null })
    },

    clearError: () => set({ error: null }),
}))
