/**
 * providerHealthModel — pins the single resolution order + the selectability gate
 * that every provider surface now shares.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveProviderHealth,
  PROVIDER_HEALTH_META,
  type ProviderHealthState,
} from '../providerHealthModel'

describe('resolveProviderHealth', () => {
  it('maps backend status when there is no sweep', () => {
    expect(resolveProviderHealth({ backend: { status: 'ready' } }).state).toBe('online')
    expect(resolveProviderHealth({ backend: { status: 'unavailable' } }).state).toBe('offline')
    expect(resolveProviderHealth({ backend: { status: 'unknown' } }).state).toBe('unknown')
  })

  it('is unknown with no signals at all', () => {
    expect(resolveProviderHealth({}).state).toBe('unknown')
    expect(resolveProviderHealth({ backend: null, sweep: null }).state).toBe('unknown')
  })

  it('prefers a conclusive local sweep over the backend', () => {
    // Freshest user-initiated truth wins: a Test that just succeeded overrides a
    // stale "unavailable" baseline, and vice-versa.
    expect(resolveProviderHealth({
      backend: { status: 'unavailable' }, sweep: { status: 'healthy' },
    }).state).toBe('online')
    expect(resolveProviderHealth({
      backend: { status: 'ready' }, sweep: { status: 'unhealthy' },
    }).state).toBe('offline')
    expect(resolveProviderHealth({ sweep: { status: 'checking' } }).state).toBe('checking')
  })

  it('defers an inconclusive (unknown) sweep to the backend', () => {
    expect(resolveProviderHealth({
      backend: { status: 'unavailable' }, sweep: { status: 'unknown' },
    }).state).toBe('offline')
  })

  it('carries the error through from whichever signal won', () => {
    expect(resolveProviderHealth({
      backend: { status: 'unavailable', error: 'Provider circuit: instantiation_failed' },
    }).error).toBe('Provider circuit: instantiation_failed')
    expect(resolveProviderHealth({
      sweep: { status: 'unhealthy', error: 'connect timeout' },
    }).error).toBe('connect timeout')
  })
})

describe('PROVIDER_HEALTH_META gate', () => {
  it('blocks creation ONLY on a confirmed-offline provider', () => {
    // The core policy: unknown/checking must stay selectable so a cold start or a
    // non-admin with no status feed is never falsely locked out; the backend is the
    // authoritative gate there. Only a proven-down provider is blocked in the UI.
    const selectable: Record<ProviderHealthState, boolean> = {
      online: true, checking: true, unknown: true, offline: false,
    }
    for (const state of Object.keys(selectable) as ProviderHealthState[]) {
      expect(PROVIDER_HEALTH_META[state].selectable).toBe(selectable[state])
    }
  })
})
