import { describe, it, expect } from 'vitest'
import { assetStatsRefetchInterval, PROVIDER_DOWN_RECOVERY_POLL_MS } from './useAssetStats'
import type { InsightsMeta } from '@/types/insights'

const POLL = 5_000

const base: InsightsMeta = {
    status: 'fresh',
    source: 'cache',
    updated_at: null,
    staleness_secs: 10,
    ttl_seconds: null,
    refreshing: false,
    job_id: null,
    poll_url: null,
    provider_health: 'ok',
    last_error: null,
}

describe('assetStatsRefetchInterval', () => {
    it('does not poll a fresh, healthy row', () => {
        expect(assetStatsRefetchInterval(base, POLL)).toBe(false)
    })

    it('polls fast while a refresh job is genuinely in flight', () => {
        expect(assetStatsRefetchInterval({ ...base, refreshing: true }, POLL)).toBe(POLL)
    })

    it('polls fast while a first-ever compute is running', () => {
        expect(assetStatsRefetchInterval({ ...base, status: 'computing' }, POLL)).toBe(POLL)
    })

    it('keeps a slow recovery poll running while the provider is offline (the "Cached" chip)', () => {
        // fresh figures + provider down
        expect(
            assetStatsRefetchInterval({ ...base, provider_health: 'down' }, POLL),
        ).toBe(PROVIDER_DOWN_RECOVERY_POLL_MS)
        // stale figures + provider down — still probing for recovery
        expect(
            assetStatsRefetchInterval(
                { ...base, status: 'stale', provider_health: 'down' },
                POLL,
            ),
        ).toBe(PROVIDER_DOWN_RECOVERY_POLL_MS)
    })

    it('stops polling once the provider recovers', () => {
        expect(
            assetStatsRefetchInterval(
                { ...base, status: 'stale', provider_health: 'ok' },
                POLL,
            ),
        ).toBe(false)
    })

    it('does not poll a stale, healthy row — its refresh is the background sweep\'s job', () => {
        expect(assetStatsRefetchInterval({ ...base, status: 'stale' }, POLL)).toBe(false)
    })

    it('returns false when there is no envelope yet', () => {
        expect(assetStatsRefetchInterval(undefined, POLL)).toBe(false)
    })
})
