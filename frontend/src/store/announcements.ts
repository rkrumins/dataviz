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
import { POLLING_INTERVALS } from '@/config/polling'

/** Map of announcement id → timestamp (ms) when snooze expires. */
type SnoozeMap = Record<string, number>

/** Compare the fields the banner renders, so an identical poll is a no-op. */
function announcementsEqual(a: AnnouncementResponse[], b: AnnouncementResponse[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (
      x.id !== y.id || x.title !== y.title || x.message !== y.message ||
      x.bannerType !== y.bannerType || x.snoozeDurationMinutes !== y.snoozeDurationMinutes ||
      x.ctaText !== y.ctaText || x.ctaUrl !== y.ctaUrl || x.updatedAt !== y.updatedAt
    ) return false
  }
  return true
}

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
      // 60s fallback (was a hardcoded 15s — the app's highest-frequency
      // idle poll). Wires the previously-dead POLLING_INTERVALS.announcements
      // constant; backend /announcements/config still overrides via fetchConfig.
      pollIntervalSeconds: POLLING_INTERVALS.announcements / 1000,
      defaultSnoozeMinutes: 30,
      isLoading: false,
      error: null,

      fetchActive: async () => {
        try {
          const data = await announcementService.getActive()
          const prev = get()
          // The banner subscribes to the whole store, so any set() re-renders
          // it. Skip the write when the active set is unchanged (identical
          // poll, or the common steady-state with zero announcements).
          if (announcementsEqual(prev.announcements, data) && !prev.isLoading && prev.error === null) return
          set({ announcements: data, isLoading: false, error: null })
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
