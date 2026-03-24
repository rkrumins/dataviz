// SECURITY NOTE: The JWT is stored in localStorage via Zustand persist.
// localStorage is accessible to any JS running on the page, making it
// vulnerable to XSS.  The backend's CSP headers mitigate this, but for
// maximum security the token should migrate to an HttpOnly cookie set by
// the backend.  This requires backend cookie-setting endpoints, CSRF
// protection, and updating all API calls to use credentials: 'include'.
// Tracked for v2.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { authService, type UserPublicResponse, type SignUpRequest } from '@/services/authService'

interface AuthState {
    isAuthenticated: boolean
    user: UserPublicResponse | null
    accessToken: string | null
    error: string | null
    isLoading: boolean
    /** True when a 401 was received but the user hasn't been fully logged out.
     *  Lets the UI show a re-auth prompt instead of a hard redirect. */
    sessionExpired: boolean
    login: (email: string, password: string) => Promise<boolean>
    signup: (req: SignUpRequest) => Promise<{ ok: boolean; message: string }>
    logout: () => void
    /** Mark the session as expired without clearing user data. */
    expireSession: () => void
    clearError: () => void
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            isAuthenticated: false,
            user: null,
            accessToken: null,
            error: null,
            isLoading: false,
            sessionExpired: false,

            login: async (email, password) => {
                set({ error: null, isLoading: true, sessionExpired: false })
                try {
                    const resp = await authService.login({ email, password })
                    set({
                        isAuthenticated: true,
                        user: resp.user,
                        accessToken: resp.accessToken,
                        error: null,
                        isLoading: false,
                        sessionExpired: false,
                    })
                    return true
                } catch (err: any) {
                    set({
                        isAuthenticated: false,
                        user: null,
                        accessToken: null,
                        error: err.message || 'Login failed',
                        isLoading: false,
                    })
                    return false
                }
            },

            signup: async (req) => {
                set({ error: null, isLoading: true })
                try {
                    const resp = await authService.signup(req)
                    set({ isLoading: false })
                    return { ok: true, message: resp.message }
                } catch (err: any) {
                    const message = err.message || 'Signup failed'
                    set({ error: message, isLoading: false })
                    return { ok: false, message }
                }
            },

            logout: () => {
                set({
                    isAuthenticated: false,
                    user: null,
                    accessToken: null,
                    error: null,
                    isLoading: false,
                    sessionExpired: false,
                })
            },

            expireSession: () => {
                set({ sessionExpired: true })
            },

            clearError: () => {
                set({ error: null })
            },
        }),
        {
            name: 'nexus-auth-storage',
            partialize: (state) => ({
                isAuthenticated: state.isAuthenticated,
                user: state.user,
                accessToken: state.accessToken,
            }),
        }
    )
)
