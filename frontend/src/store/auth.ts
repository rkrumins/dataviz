import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { authService, type UserPublicResponse, type SignUpRequest } from '@/services/authService'

interface AuthState {
    isAuthenticated: boolean
    user: UserPublicResponse | null
    accessToken: string | null
    error: string | null
    isLoading: boolean
    login: (email: string, password: string) => Promise<boolean>
    signup: (req: SignUpRequest) => Promise<{ ok: boolean; message: string }>
    logout: () => void
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

            login: async (email, password) => {
                set({ error: null, isLoading: true })
                try {
                    const resp = await authService.login({ email, password })
                    set({
                        isAuthenticated: true,
                        user: resp.user,
                        accessToken: resp.accessToken,
                        error: null,
                        isLoading: false,
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
                })
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
