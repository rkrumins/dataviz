/**
 * Table-driven tests for assetListState — the classifier that decides how a
 * nothing-to-show asset-list envelope renders.
 *
 * The invariant under test: only a `ready` envelope (fresh/stale with a real
 * assets array) may render the true "No data sources found" empty state.
 * Transient backend states — computing, unavailable (data:null), and the
 * discovery failure stub (payload `{}`) — must classify as their own states,
 * because rendering them as "empty provider" is exactly the bug where items
 * appeared to vanish and reappear at random.
 */

import { describe, expect, it } from 'vitest'

import { assetListIsBuilding, assetListState } from '../useProviderAssets'
import type { Envelope, AssetListPayload, InsightsMeta } from '@/types/insights'

function meta(overrides: Partial<InsightsMeta> = {}): InsightsMeta {
  return {
    status: 'fresh',
    source: 'cache',
    updated_at: null,
    staleness_secs: null,
    ttl_seconds: null,
    refreshing: false,
    job_id: null,
    poll_url: null,
    provider_health: 'ok',
    last_error: null,
    ...overrides,
  }
}

function envelope(
  data: AssetListPayload | null,
  metaOverrides: Partial<InsightsMeta> = {},
): Envelope<AssetListPayload> {
  return { data, meta: meta(metaOverrides) }
}

describe('assetListState', () => {
  it('classifies a missing envelope as loading (query not resolved yet)', () => {
    expect(assetListState(null)).toBe('loading')
    expect(assetListState(undefined)).toBe('loading')
  })

  it('classifies computing as loading, even with data:null', () => {
    expect(assetListState(envelope(null, { status: 'computing', source: 'none' })))
      .toBe('loading')
  })

  it('classifies unavailable (data:null, no job in flight) as unavailable', () => {
    expect(assetListState(envelope(null, { status: 'unavailable', source: 'none' })))
      .toBe('unavailable')
  })

  it('classifies a null payload as unavailable regardless of status', () => {
    // A fresh row whose payload failed to parse serves data:null too.
    expect(assetListState(envelope(null))).toBe('unavailable')
  })

  it('classifies the discovery failure stub (payload {}) as error-stub', () => {
    // record_failure writes payload "{}" when listing fails with no prior
    // row — data is non-null but carries no assets array.
    const stub = envelope({} as AssetListPayload, {
      status: 'stale',
      last_error: 'tcp_refused: falkordb:6379',
    })
    expect(assetListState(stub)).toBe('error-stub')
  })

  it('classifies fresh/stale envelopes with a real array as ready', () => {
    expect(assetListState(envelope({ assets: [] }))).toBe('ready')
    expect(assetListState(envelope({ assets: ['graph_a'] }, { status: 'stale' })))
      .toBe('ready')
  })
})

/**
 * `assetListIsBuilding` is the asset-list query's poll signal.
 *
 * The reported bug: clicking Refresh queued a list-all discovery job, but the
 * list query only polled while `status === 'computing'`. A provider that
 * already has a cached list is never `computing` — it is served verbatim as
 * `fresh`/`stale` with `refreshing: true` — so nothing re-fetched while the
 * job ran, the post-refresh invalidation raced it and usually landed on the
 * same stale payload, and a newly-created graph stayed invisible.
 */
describe('assetListIsBuilding', () => {
  it('polls while a re-list is in flight over an existing list', () => {
    expect(assetListIsBuilding(envelope({ assets: ['g1'] }, {
      status: 'fresh', refreshing: true,
    }))).toBe(true)
    expect(assetListIsBuilding(envelope({ assets: ['g1'] }, {
      status: 'stale', refreshing: true,
    }))).toBe(true)
  })

  it('polls while a cold cache is being computed', () => {
    expect(assetListIsBuilding(envelope(null, { status: 'computing' }))).toBe(true)
  })

  it('stops once the list has landed', () => {
    expect(assetListIsBuilding(envelope({ assets: ['g1'] }, {
      status: 'fresh', refreshing: false,
    }))).toBe(false)
    expect(assetListIsBuilding(envelope(null, {
      status: 'unavailable', refreshing: false,
    }))).toBe(false)
  })

  it('does not poll before the first envelope arrives', () => {
    expect(assetListIsBuilding(undefined)).toBe(false)
    expect(assetListIsBuilding(null)).toBe(false)
  })
})
