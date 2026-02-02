import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { hashPassword } from '@/utils/crypto'

interface AuthState {
    isAuthenticated: boolean
    user: { name: string; role: string } | null
    error: string | null
    failedAttempts: number
    lockoutUntil: string | null
    login: (username: string, password: string) => Promise<boolean>
    logout: () => void
    clearError: () => void
}

const EXPECTED_USERNAME = import.meta.env.VITE_AUTH_USERNAME || 'admin'
const EXPECTED_HASH = import.meta.env.VITE_AUTH_PASSWORD_HASH
const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 30 * 60 * 1000 // 30 minutes

export const useAuthStore = create<AuthState>()(
    persist(
        (set, get) => ({
            isAuthenticated: false,
            user: null,
            error: null,
            failedAttempts: 0,
            lockoutUntil: null,

            login: async (username, password) => {
                const state = get()

                // Check for lockout
                if (state.lockoutUntil) {
                    const lockoutTime = new Date(state.lockoutUntil).getTime()
                    const now = Date.now()
                    if (now < lockoutTime) {
                        const remaining = Math.ceil((lockoutTime - now) / 60000)
                        set({ error: `Too many failed attempts. Try again in ${remaining} minutes.` })
                        return false
                    }
                }

                // Clear any previous error
                set({ error: null })

                try {
                    // Hash the input password for comparison
                    const inputHash = await hashPassword(password)

                    // Exponential backoff to deter brute forcing even before lockout
                    const delay = Math.min(10000, 800 * Math.pow(1.5, state.failedAttempts))
                    await new Promise(resolve => setTimeout(resolve, delay))

                    if (username === EXPECTED_USERNAME && inputHash === EXPECTED_HASH) {
                        set({
                            isAuthenticated: true,
                            user: { name: 'Admin User', role: 'administrator' },
                            error: null,
                            failedAttempts: 0,
                            lockoutUntil: null,
                        })
                        return true
                    } else {
                        const nextAttempts = state.failedAttempts + 1
                        let lockoutUntil = null
                        let error = 'Invalid username or password'

                        if (nextAttempts >= MAX_ATTEMPTS) {
                            lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
                            error = 'Too many failed attempts. Account locked for 15 minutes.'
                        }

                        set({
                            isAuthenticated: false,
                            user: null,
                            failedAttempts: nextAttempts,
                            lockoutUntil,
                            error,
                        })
                        return false
                    }
                } catch (err) {
                    set({
                        isAuthenticated: false,
                        user: null,
                        error: 'Authentication failed due to an internal error',
                    })
                    return false
                }
            },

            logout: () => {
                set({ isAuthenticated: false, user: null, failedAttempts: 0, lockoutUntil: null })
            },

            clearError: () => {
                set({ error: null })
            },
        }),
        {
            name: 'nexus-auth-storage',
        }
    )
)
