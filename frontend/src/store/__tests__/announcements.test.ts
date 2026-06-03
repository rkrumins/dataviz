import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnnouncementStore } from '../announcements'
import { announcementService, type AnnouncementResponse } from '@/services/announcementService'

function ann(over: Partial<AnnouncementResponse> = {}): AnnouncementResponse {
  return {
    id: 'a1',
    title: 'Heads up',
    message: 'Scheduled maintenance tonight',
    bannerType: 'info',
    isActive: true,
    snoozeDurationMinutes: 30,
    ctaText: null,
    ctaUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('announcements store — fetchActive dedupe', () => {
  beforeEach(() => {
    useAnnouncementStore.setState({ announcements: [], isLoading: false, error: null })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves the announcements reference across an identical poll', async () => {
    const spy = vi.spyOn(announcementService, 'getActive')

    spy.mockResolvedValueOnce([ann()])
    await useAnnouncementStore.getState().fetchActive()
    const ref1 = useAnnouncementStore.getState().announcements

    spy.mockResolvedValueOnce([ann()]) // same content, new array instance
    await useAnnouncementStore.getState().fetchActive()
    const ref2 = useAnnouncementStore.getState().announcements

    expect(ref2).toBe(ref1)
  })

  it('is a no-op in the steady state with zero announcements', async () => {
    const spy = vi.spyOn(announcementService, 'getActive')
    const ref1 = useAnnouncementStore.getState().announcements // initial []

    spy.mockResolvedValueOnce([])
    await useAnnouncementStore.getState().fetchActive()

    expect(useAnnouncementStore.getState().announcements).toBe(ref1)
  })

  it('updates when announcement content changes', async () => {
    const spy = vi.spyOn(announcementService, 'getActive')

    spy.mockResolvedValueOnce([ann()])
    await useAnnouncementStore.getState().fetchActive()
    const ref1 = useAnnouncementStore.getState().announcements

    spy.mockResolvedValueOnce([ann({ message: 'Maintenance finished', updatedAt: '2026-01-02T00:00:00Z' })])
    await useAnnouncementStore.getState().fetchActive()
    const after = useAnnouncementStore.getState().announcements

    expect(after).not.toBe(ref1)
    expect(after[0].message).toBe('Maintenance finished')
  })
})
