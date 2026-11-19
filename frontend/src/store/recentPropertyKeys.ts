/**
 * The property names this person added most recently (20, newest first) — offered again when they
 * add a property somewhere else. Kept in this browser only; a convenience, never a record.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const MAX = 20

interface RecentPropertyKeysState {
  keys: string[]
  remember: (keys: readonly string[]) => void
}

export const useRecentPropertyKeys = create<RecentPropertyKeysState>()(
  persist(
    (set) => ({
      keys: [],
      remember: (added) => set((s) => ({
        keys: [...new Set([...[...added].reverse(), ...s.keys])].filter(Boolean).slice(0, MAX),
      })),
    }),
    { name: 'nexus-recent-property-keys' },
  ),
)
