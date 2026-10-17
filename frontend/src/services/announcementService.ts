/**
 * Announcement service — CRUD for global announcement banners.
 *
 * Public endpoint (no auth): GET /api/v1/announcements
 * Admin endpoints (auth required): /api/v1/admin/announcements
 */
import { authFetch } from './apiClient'
import { fetchWithTimeout } from './fetchWithTimeout'
import { POLLING_INTERVALS } from '@/config/polling'

const PUBLIC_URL = '/api/v1/announcements'
const ADMIN_URL = '/api/v1/admin/announcements'

export interface AnnouncementResponse {
  id: string
  title: string
  message: string
  bannerType: 'info' | 'warning' | 'success'
  isActive: boolean
  /** Minutes the user can snooze this banner. 0 = no snooze allowed. */
  snoozeDurationMinutes: number
  ctaText?: string | null
  ctaUrl?: string | null
  createdBy?: string | null
  updatedBy?: string | null
  createdAt: string
  updatedAt: string
}

export interface AnnouncementCreateRequest {
  title: string
  message: string
  bannerType?: 'info' | 'warning' | 'success'
  isActive?: boolean
  snoozeDurationMinutes?: number
  ctaText?: string | null
  ctaUrl?: string | null
}

export interface AnnouncementUpdateRequest {
  title?: string
  message?: string
  bannerType?: 'info' | 'warning' | 'success'
  isActive?: boolean
  snoozeDurationMinutes?: number
  ctaText?: string | null
  ctaUrl?: string | null
}

export interface AnnouncementConfigResponse {
  pollIntervalSeconds: number
  defaultSnoozeMinutes: number
  updatedBy?: string | null
  updatedAt?: string | null
}

export interface AnnouncementConfigUpdateRequest {
  pollIntervalSeconds?: number
  defaultSnoozeMinutes?: number
}

export const announcementService = {
  /** Fetch active announcements (public, no auth needed for banner display). */
  async getActive(): Promise<AnnouncementResponse[]> {
    try {
      const res = await fetchWithTimeout(PUBLIC_URL)
      if (!res.ok) return []
      return res.json()
    } catch {
      return []
    }
  },

  /** Admin: list all announcements (active and inactive). */
  async listAll(): Promise<AnnouncementResponse[]> {
    return authFetch<AnnouncementResponse[]>(ADMIN_URL)
  },

  /** Admin: create a new announcement. */
  async create(req: AnnouncementCreateRequest): Promise<AnnouncementResponse> {
    return authFetch<AnnouncementResponse>(ADMIN_URL, {
      method: 'POST',
      body: JSON.stringify(req),
    })
  },

  /** Admin: update an existing announcement. */
  async update(id: string, req: AnnouncementUpdateRequest): Promise<AnnouncementResponse> {
    return authFetch<AnnouncementResponse>(`${ADMIN_URL}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(req),
    })
  },

  /** Admin: delete an announcement. */
  async remove(id: string): Promise<void> {
    return authFetch<void>(`${ADMIN_URL}/${id}`, {
      method: 'DELETE',
    })
  },

  /**
   * Fetch global banner config (public, no auth).
   *
   * The failure fallback matches ``POLLING_INTERVALS.announcements`` rather
   * than undercutting it. It used to return 15s, so a config endpoint that
   * 404'd or timed out quietly put every tab on a 4x faster poll than the
   * tuned constant — the failure mode made the load problem worse instead of
   * degrading to the documented baseline.
   */
  async getConfig(): Promise<AnnouncementConfigResponse> {
    const fallback = {
      pollIntervalSeconds: POLLING_INTERVALS.announcements / 1000,
      defaultSnoozeMinutes: 30,
    }
    try {
      const res = await fetchWithTimeout(`${PUBLIC_URL}/config`)
      if (!res.ok) return fallback
      return res.json()
    } catch {
      return fallback
    }
  },

  /** Admin: read config. */
  async getAdminConfig(): Promise<AnnouncementConfigResponse> {
    return authFetch<AnnouncementConfigResponse>(`${ADMIN_URL}/config`)
  },

  /** Admin: update config. */
  async updateConfig(req: AnnouncementConfigUpdateRequest): Promise<AnnouncementConfigResponse> {
    return authFetch<AnnouncementConfigResponse>(`${ADMIN_URL}/config`, {
      method: 'PUT',
      body: JSON.stringify(req),
    })
  },
}
