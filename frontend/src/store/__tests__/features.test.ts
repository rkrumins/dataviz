/**
 * Features store — boot-time flag hydration contract:
 * seeded defaults render first, served values merge over them, a failed
 * fetch keeps the seeds (FAIL-OPEN: the server 403 gate is the enforcement,
 * a network blip must never hide product areas), and unknown keys coerce
 * predictably.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/featuresService', () => ({
  fetchPublicFeatureValues: vi.fn(),
}))

import { fetchPublicFeatureValues } from '@/services/featuresService'
import {
  DEFAULT_FEATURES,
  featureEnabled,
  startFeaturesSync,
  useFeaturesStore,
} from '@/store/features'

const fetchMock = vi.mocked(fetchPublicFeatureValues)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES }, loaded: false })
})

describe('features store', () => {
  it('seeds versioningEnabled=true so first paint shows the full product', () => {
    expect(featureEnabled('versioningEnabled')).toBe(true)
    expect(useFeaturesStore.getState().loaded).toBe(false)
  })

  it('merges served values over the seeds', async () => {
    fetchMock.mockResolvedValue({ versioningEnabled: false, somethingElse: true })

    await useFeaturesStore.getState().loadFeatures()

    expect(featureEnabled('versioningEnabled')).toBe(false)
    expect(featureEnabled('somethingElse')).toBe(true)
    expect(useFeaturesStore.getState().loaded).toBe(true)
  })

  it('keeps the seeds when the fetch fails (fail-open)', async () => {
    fetchMock.mockResolvedValue(null)

    await useFeaturesStore.getState().loadFeatures()

    expect(featureEnabled('versioningEnabled')).toBe(true)
    expect(useFeaturesStore.getState().loaded).toBe(true)
  })

  it('a served payload missing a seeded key falls back to the seed default', async () => {
    fetchMock.mockResolvedValue({ unrelatedFlag: false })

    await useFeaturesStore.getState().loadFeatures()

    expect(featureEnabled('versioningEnabled')).toBe(true)
  })

  it('unknown keys without a seed coerce to false', () => {
    expect(featureEnabled('neverHeardOfIt')).toBe(false)
  })

  it('null/undefined served values fall back to the seed', async () => {
    fetchMock.mockResolvedValue({ versioningEnabled: null as unknown as boolean })

    await useFeaturesStore.getState().loadFeatures()

    expect(featureEnabled('versioningEnabled')).toBe(true)
  })

  it('caches served values so the next boot seeds from them (no flash)', async () => {
    fetchMock.mockResolvedValue({ versioningEnabled: false })

    await useFeaturesStore.getState().loadFeatures()

    expect(JSON.parse(localStorage.getItem('nx-features-cache') ?? '{}')).toEqual({
      versioningEnabled: false,
    })
  })

  // ── the bug that shipped: a flag that lies ─────────────────────────────────
  //
  // The values were always DB-owned and the API always served them correctly. What was
  // missing was any way for a change to REACH a running client: loadFeatures() ran once at
  // boot and nothing ever asked again. An admin could turn version control off, the database
  // and the API would agree it was off, the server would refuse every versioning write — and
  // every open tab, INCLUDING THE ADMIN'S OWN, went on offering the buttons.

  it('an admin save reaches the running app, not just the admin page', () => {
    expect(featureEnabled('versioningEnabled')).toBe(true)
    // What useAdminFeatures now does after a successful PATCH:
    useFeaturesStore.getState().setValues({ versioningEnabled: false })
    expect(featureEnabled('versioningEnabled')).toBe(false)
  })

  it('re-checks the flags when the tab is looked at again', async () => {
    fetchMock.mockResolvedValue({ versioningEnabled: false })
    const stop = startFeaturesSync()
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      await vi.waitFor(() => expect(featureEnabled('versioningEnabled')).toBe(false))
    } finally {
      stop()
    }
  })

  it('a hidden tab does not poll — it refreshes the moment it is looked at', () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const stop = startFeaturesSync()
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      stop(); spy.mockRestore()
    }
  })

  it('stops listening when torn down', () => {
    const stop = startFeaturesSync()
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

