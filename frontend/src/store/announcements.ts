/**
 * Global announcement banner store.
 *
 * - Fetches active announcements from the public API.
 * - Fetches global config (polling interval, default snooze) from backend.
 * - Tracks snooze state: users can temporarily hide a banner for the
 *   admin-configured duration.  After expiry it reappears automatically.
 * - Polling interval is admin-configurable (persisted in the DB).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { announcementService, type AnnouncementResponse } from '@/services/announcementService'

/** Map of announcement id → timestamp (ms) when snooze expires. */
type SnoozeMap = Record<string, number>

interface AnnouncementState {
  announcements: AnnouncementResponse[]
  /** id → epoch ms when snooze expires. Persisted in localStorage. */
  snoozedUntil: SnoozeMap
  /** Polling interval in seconds — fetched from backend config. */
  pollIntervalSeconds: number
  /** Default snooze duration in minutes — fetched from backend config. */
  defaultSnoozeMinutes: number
  isLoading: boolean
  error: string | null

  fetchActive: () => Promise<void>
  fetchConfig: () => Promise<void>
  /** Snooze a banner for `durationMinutes`. */
  snooze: (id: string, durationMinutes: number) => void
  /** Check if a banner is currently snoozed (not expired). */
  isSnoozed: (id: string) => boolean
}

export const useAnnouncementStore = create<AnnouncementState>()(
  persist(
    (set, get) => ({
      announcements: [],
      snoozedUntil: {},
      pollIntervalSeconds: 15,
      defaultSnoozeMinutes: 30,
      isLoading: false,
      error: null,

      fetchActive: async () => {
        // Don't set isLoading on subsequent polls — only first load
        const isFirst = get().announcements.length === 0
        if (isFirst) set({ isLoading: true })
        set({ error: null })
        try {
          const data = await announcementService.getActive()
          set({ announcements: data, isLoading: false })
        } catch (err: any) {
          set({ error: err.message, isLoading: false })
        }
      },

      fetchConfig: async () => {
        try {
          const cfg = await announcementService.getConfig()
          set({
            pollIntervalSeconds: cfg.pollIntervalSeconds,
            defaultSnoozeMinutes: cfg.defaultSnoozeMinutes,
          })
        } catch {
          // keep defaults on error
        }
      },

      snooze: (id: string, durationMinutes: number) => {
        const expiresAt = Date.now() + durationMinutes * 60 * 1000
        set((s) => ({
          snoozedUntil: { ...s.snoozedUntil, [id]: expiresAt },
        }))
      },

      isSnoozed: (id: string) => {
        const expiresAt = get().snoozedUntil[id]
        if (!expiresAt) return false
        return Date.now() < expiresAt
      },
    }),
    {
      name: 'synodic-announcements',
      // Only persist snooze expiry times, not fetched data or config
      partialize: (state) => ({ snoozedUntil: state.snoozedUntil }),
    }
  )
)
