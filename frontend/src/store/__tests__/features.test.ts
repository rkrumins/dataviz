/**
 * Features store — boot-time flag hydration contract:
 * seeded defaults render first, served values merge over them, a failed
 * fetch keeps the seeds (FAIL-OPEN: the server 403 gate is the enforcement,
 * a network blip must never hide product areas), and unknown keys coerce
 * predictably.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/featuresService', () => ({
  fetchPublicFeatureValues: vi.fn(),
}))

import { fetchPublicFeatureValues } from '@/services/featuresService'
import {
  DEFAULT_FEATURES,
  featureEnabled,
  useFeatureList,
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

// ── The seeds decide what happens when the server is unreachable ──────────────
//
// `coerce()` falls back to DEFAULT_FEATURES when a key is absent, and an absent key with NO seed
// reads as FALSE. So a flag missing from the seeds is a feature that VANISHES on a failed fetch.
// Only `versioningEnabled` was ever seeded, which meant the store's fail-open promise held for
// exactly one flag: a network blip would have hidden lineage tracing and the semantic-layer
// editor, making the product look broken in the name of a setting nobody had changed.

describe('fail-open seeds', () => {
  const CAPABILITIES = [
    'versioningEnabled',
    'editModeEnabled',
    'traceEnabled',
    'semanticLayerEditMode',
    'semanticLayerImportEnabled',
    'semanticLayerExportEnabled',
    'semanticLayerAutoSuggest',
    'semanticLayerVersionHistory',
  ]

  it('keeps every capability available when the flag fetch fails', async () => {
    vi.mocked(fetchPublicFeatureValues).mockResolvedValue(null)
    await useFeaturesStore.getState().loadFeatures()

    for (const key of CAPABILITIES) {
      expect(featureEnabled(key), `${key} disappeared when the server was unreachable`).toBe(true)
    }
  })

  it('fails CLOSED for the two flags that widen access', async () => {
    vi.mocked(fetchPublicFeatureValues).mockResolvedValue(null)
    await useFeaturesStore.getState().loadFeatures()

    // signupEnabled is a door: if we cannot tell whether the admin left it open, it stays shut.
    expect(featureEnabled('signupEnabled')).toBe(false)
    // Same logic — this one decides whether a NON-admin may write to a semantic layer.
    expect(featureEnabled('semanticLayerNonAdminEditing')).toBe(false)
  })

  it('seeds allowedViewModes as a list, not a boolean', () => {
    // It is a set of layouts, and a `useFeature()` boolean read of it would be meaningless.
    expect(DEFAULT_FEATURES.allowedViewModes).toEqual(
      ['graph', 'hierarchy', 'reference', 'layered-lineage'],
    )
  })
})

// ── List flags are a SET, not a switch ───────────────────────────────────────

describe('useFeatureList', () => {
  const read = () => renderHook(() => useFeatureList('allowedViewModes')).result.current

  it('returns null (= no restriction) when the value is unusable', () => {
    // null must NOT be read as "nothing allowed". The server is the enforcement; a client that
    // guessed "nothing" on a slow network would blank out the layout picker over a setting
    // nobody had touched.
    useFeaturesStore.setState({ values: { allowedViewModes: [] } })
    expect(read()).toBeNull()

    useFeaturesStore.setState({ values: { allowedViewModes: 'graph' } })
    expect(read()).toBeNull()
  })

  it('falls back to the seed when the admin has never saved', () => {
    useFeaturesStore.setState({ values: {} })
    expect(read()).toEqual(['graph', 'hierarchy', 'reference', 'layered-lineage'])
  })

  it("returns the admin's selection when there is one", () => {
    useFeaturesStore.setState({ values: { allowedViewModes: ['graph'] } })
    expect(read()).toEqual(['graph'])
  })
})
