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
  useFeaturesStore,
} from '@/store/features'

const fetchMock = vi.mocked(fetchPublicFeatureValues)

beforeEach(() => {
  vi.clearAllMocks()
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
})
