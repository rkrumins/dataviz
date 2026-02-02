import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { hashPassword } from '@/utils/crypto'

interface AuthState {
    isAuthenticated: boolean
    user: { name: string; role: string } | null
    error: string | null
    login: (username: string, password: string) => Promise<boolean>
    logout: () => void
    clearError: () => void
}

const EXPECTED_USERNAME = import.meta.env.VITE_AUTH_USERNAME || 'admin'
const EXPECTED_HASH = import.meta.env.VITE_AUTH_PASSWORD_HASH

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            isAuthenticated: false,
            user: null,
            error: null,

            login: async (username, password) => {
                // Clear any previous error
                set({ error: null })

                try {
                    // Hash the input password for comparison
                    const inputHash = await hashPassword(password)

                    // Small delay for UX and to prevent rapid brute forcing
                    await new Promise(resolve => setTimeout(resolve, 800))

                    if (username === EXPECTED_USERNAME && inputHash === EXPECTED_HASH) {
                        set({
                            isAuthenticated: true,
                            user: { name: 'Admin User', role: 'administrator' },
                            error: null,
                        })
                        return true
                    } else {
                        set({
                            isAuthenticated: false,
                            user: null,
                            error: 'Invalid username or password',
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
                set({ isAuthenticated: false, user: null })
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
