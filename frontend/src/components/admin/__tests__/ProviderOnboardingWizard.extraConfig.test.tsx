/**
 * The wizard rebuilds extra_config from its form fields and the backend
 * REPLACES extra_config wholesale on update — so every key the form does not
 * own (falkordbConnection.addressRemap / connectTimeout / probeDeadlineS,
 * sentinel.tls, ops-set top-level keys, ...) must be carried through from the
 * loaded provider or a routine Save silently deletes it. addressRemap is the
 * cross-cluster reachability fix: wiping it on edit re-breaks production.
 */
import { describe, it, expect } from 'vitest'

import {
  buildExtraConfig,
  buildInitialFormData,
} from '../ProviderOnboardingWizard'
import type { ProviderResponse } from '@/services/providerService'

const FALKOR_PROVIDER = {
  id: 'prov_1',
  name: 'graph',
  providerType: 'falkordb',
  host: 'falkordb',
  port: 6379,
  tlsEnabled: false,
  isActive: true,
  authConfigured: true,
  cacheAuthConfigured: false,
  extraConfig: {
    falkordbConnection: {
      mode: 'sentinel',
      sentinel: {
        masterName: 'mymaster',
        nodes: [['s1', 26379], ['s2', 26379]],
        // Keys the sentinel panel does NOT edit — must survive a Save.
        tls: { enabled: false },
        authEnabled: true,
      },
      socketTimeout: 10,
      // Advanced knobs the form does not render — must survive a Save.
      addressRemap: { '10.0.0.5:6379': 'edge.example.com:6379' },
      connectTimeout: 5,
      probeDeadlineS: 6,
    },
    // Arbitrary ops-set top-level key the form knows nothing about.
    opsAnnotations: { owner: 'data-platform' },
  },
} as unknown as ProviderResponse

describe('buildExtraConfig carry-through (edit mode)', () => {
  it('preserves unknown falkordbConnection keys and top-level keys on an untouched save', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const out = buildExtraConfig(formData)!

    expect(out.opsAnnotations).toEqual({ owner: 'data-platform' })
    const conn = out.falkordbConnection as Record<string, any>
    expect(conn.addressRemap).toEqual({ '10.0.0.5:6379': 'edge.example.com:6379' })
    expect(conn.connectTimeout).toBe(5)
    expect(conn.probeDeadlineS).toBe(6)
    // Form-owned keys still round-trip.
    expect(conn.mode).toBe('sentinel')
    expect(conn.sentinel.masterName).toBe('mymaster')
    expect(conn.sentinel.nodes).toEqual([['s1', 26379], ['s2', 26379]])
    expect(conn.socketTimeout).toBe(10)
    // Keys inside the form-owned `sentinel` object that the panel does not
    // edit are preserved too.
    expect(conn.sentinel.tls).toEqual({ enabled: false })
    expect(conn.sentinel.authEnabled).toBe(true)
  })

  it('a form-owned edit updates that key without disturbing the preserved ones', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    formData.falkordbConnection!.socketTimeout = '30'
    formData.falkordbConnection!.sentinelMasterName = 'newmaster'
    const out = buildExtraConfig(formData)!

    const conn = out.falkordbConnection as Record<string, any>
    expect(conn.socketTimeout).toBe(30)
    expect(conn.sentinel.masterName).toBe('newmaster')
    expect(conn.addressRemap).toEqual({ '10.0.0.5:6379': 'edge.example.com:6379' })
    expect(conn.connectTimeout).toBe(5)
    expect(conn.probeDeadlineS).toBe(6)
    expect(conn.sentinel.tls).toEqual({ enabled: false })
    expect(out.opsAnnotations).toEqual({ owner: 'data-platform' })
  })

  it('emits falkordbConnection for a standalone provider that only has preserved knobs', () => {
    const provider = {
      ...FALKOR_PROVIDER,
      extraConfig: {
        falkordbConnection: { mode: 'standalone', connectTimeout: 5 },
      },
    } as unknown as ProviderResponse
    const out = buildExtraConfig(buildInitialFormData(provider))!
    expect(out.falkordbConnection).toMatchObject({
      mode: 'standalone',
      connectTimeout: 5,
    })
  })

  it('create mode (no provider) is unchanged: no phantom keys', () => {
    const formData = buildInitialFormData(null)
    formData.providerType = 'falkordb'
    expect(buildExtraConfig(formData)).toBeUndefined()
  })
})
