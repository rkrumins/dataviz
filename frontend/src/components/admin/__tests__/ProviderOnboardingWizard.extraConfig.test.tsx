/**
 * The wizard rebuilds extra_config from its form fields and the backend
 * REPLACES extra_config wholesale on update. Two contracts protect stored
 * config across a routine Save:
 *
 * 1. Form-owned keys (mode, sentinel, addressRemap, connectTimeout,
 *    probeDeadlineS, ...) HYDRATE into the form and are RE-EMITTED — an
 *    untouched save round-trips them, and clearing the field deletes the key.
 * 2. Everything else (ops-set top-level keys, unknown sentinel subkeys)
 *    carries through verbatim — the form must not silently delete it.
 *
 * addressRemap is the cross-cluster reachability fix: wiping it on edit
 * re-breaks production.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/store/branding', () => ({ useBrand: () => ({ appName: 'Test' }) }))
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('@/services/redisConfigService', () => ({
  fetchRedisConfig: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/services/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/providerService')>()
  return {
    ...actual,
    providerService: {
      ...actual.providerService,
      update: vi.fn().mockResolvedValue({ name: 'graph' }),
      testConnection: vi.fn().mockResolvedValue({ success: true }),
    },
  }
})

import {
  buildExtraConfig,
  buildCredentials,
  buildInitialFormData,
  ProviderOnboardingWizard,
} from '../ProviderOnboardingWizard'
import { providerService } from '@/services/providerService'
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
  sentinelAuthConfigured: false,
  extraConfig: {
    falkordbConnection: {
      mode: 'sentinel',
      sentinel: {
        masterName: 'mymaster',
        nodes: [['s1', 26379], ['s2', 26379]],
        // Form-owned since the Advanced section: tls off, daemon auth reuses
        // the data-plane creds. These hydrate and re-emit.
        tls: { enabled: false },
        authEnabled: true,
        // A subkey the panel does NOT render — must survive verbatim.
        futureDaemonKnob: 'keep-me',
      },
      socketTimeout: 10,
      // Advanced knobs — now rendered, hydrated and re-emitted.
      addressRemap: { '10.0.0.5:6379': 'edge.example.com:6379' },
      connectTimeout: 5,
      probeDeadlineS: 6,
    },
    // Arbitrary ops-set top-level key the form knows nothing about.
    opsAnnotations: { owner: 'data-platform' },
  },
} as unknown as ProviderResponse

describe('buildExtraConfig round-trip + carry-through (edit mode)', () => {
  it('an untouched save round-trips the Advanced keys and preserves unknown ones', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const out = buildExtraConfig(formData)!

    // Carry-through (not form-owned): survives verbatim.
    expect(out.opsAnnotations).toEqual({ owner: 'data-platform' })
    const conn = out.falkordbConnection as Record<string, any>
    expect(conn.sentinel.futureDaemonKnob).toBe('keep-me')
    // Form-owned Advanced keys: hydrated into the form and re-emitted.
    expect(conn.addressRemap).toEqual({ '10.0.0.5:6379': 'edge.example.com:6379' })
    expect(conn.connectTimeout).toBe(5)
    expect(conn.probeDeadlineS).toBe(6)
    expect(conn.sentinel.tls).toMatchObject({ enabled: false })
    expect(conn.sentinel.authEnabled).toBe(true)
    // Core form-owned keys still round-trip.
    expect(conn.mode).toBe('sentinel')
    expect(conn.sentinel.masterName).toBe('mymaster')
    expect(conn.sentinel.nodes).toEqual([['s1', 26379], ['s2', 26379]])
    expect(conn.socketTimeout).toBe(10)
  })

  it('a form-owned edit updates that key without disturbing the others', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    formData.falkordbConnection!.socketTimeout = '30'
    formData.falkordbConnection!.sentinelMasterName = 'newmaster'
    formData.falkordbConnection!.connectTimeout = '9'
    const out = buildExtraConfig(formData)!

    const conn = out.falkordbConnection as Record<string, any>
    expect(conn.socketTimeout).toBe(30)
    expect(conn.sentinel.masterName).toBe('newmaster')
    expect(conn.connectTimeout).toBe(9)
    expect(conn.addressRemap).toEqual({ '10.0.0.5:6379': 'edge.example.com:6379' })
    expect(conn.probeDeadlineS).toBe(6)
    expect(conn.sentinel.futureDaemonKnob).toBe('keep-me')
    expect(out.opsAnnotations).toEqual({ owner: 'data-platform' })
  })

  it('clearing an Advanced field DELETES the stored key', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const fc = formData.falkordbConnection!
    fc.connectTimeout = ''
    fc.probeDeadlineS = ''
    fc.addressRemap = []
    fc.sentinelTlsMode = 'inherit' // back to inheriting the data-plane TLS
    fc.sentinelAuthMode = 'none' // daemons unauthenticated
    const out = buildExtraConfig(formData)!

    const conn = out.falkordbConnection as Record<string, any>
    expect(conn.connectTimeout).toBeUndefined()
    expect(conn.probeDeadlineS).toBeUndefined()
    expect(conn.addressRemap).toBeUndefined()
    expect(conn.sentinel.tls).toBeUndefined()
    expect(conn.sentinel.authEnabled).toBeUndefined()
    // Unknown keys survive even a heavy Advanced edit.
    expect(conn.sentinel.futureDaemonKnob).toBe('keep-me')
    expect(out.opsAnnotations).toEqual({ owner: 'data-platform' })
  })

  it('sentinel daemon TLS "on" writes an explicit override with the CA path', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const fc = formData.falkordbConnection!
    fc.sentinelTlsMode = 'on'
    fc.sentinelTlsCaCertPath = '/certs/sentinel/ca.crt'
    const conn = buildExtraConfig(formData)!.falkordbConnection as Record<string, any>
    expect(conn.sentinel.tls).toMatchObject({
      enabled: true,
      caCertPath: '/certs/sentinel/ca.crt',
    })
  })

  it('round-trips a standalone provider whose only config is an Advanced knob', () => {
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

describe('buildCredentials — sentinel daemon credentials', () => {
  it('"dedicated" sends sentinel_username/sentinel_password; "reuse" does not', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const fc = formData.falkordbConnection!
    fc.sentinelAuthMode = 'dedicated'
    fc.sentinelUsername = 'sd-user'
    fc.sentinelPassword = 'sd-secret'
    expect(buildCredentials(formData)).toMatchObject({
      sentinel_username: 'sd-user',
      sentinel_password: 'sd-secret',
    })

    fc.sentinelAuthMode = 'reuse'
    const reuse = buildCredentials(formData)
    expect(reuse?.sentinel_username).toBeUndefined()
    expect(reuse?.sentinel_password).toBeUndefined()
    // 'reuse' rides extra_config instead.
    const conn = buildExtraConfig(formData)!.falkordbConnection as Record<string, any>
    expect(conn.sentinel.authEnabled).toBe(true)
  })

  it('graph auth OFF never sends daemon credentials (they are being cleared)', () => {
    const formData = buildInitialFormData(FALKOR_PROVIDER)
    const fc = formData.falkordbConnection!
    fc.authEnabled = false
    fc.sentinelAuthMode = 'dedicated'
    fc.sentinelUsername = 'sd-user'
    fc.sentinelPassword = 'sd-secret'
    expect(buildCredentials(formData)).toBeUndefined()
  })
})

describe('credentialsClear on daemon-auth mode change (edit submit)', () => {
  it('switching away from dedicated clears the stored daemon secrets', async () => {
    const provider = {
      ...FALKOR_PROVIDER,
      // Stored dedicated daemon creds → hydrates sentinelAuthMode='dedicated'.
      sentinelAuthConfigured: true,
    } as unknown as ProviderResponse

    render(
      <ProviderOnboardingWizard
        isOpen
        mode="edit"
        provider={provider}
        providers={[provider]}
        onClose={() => undefined}
        onCreated={() => undefined}
        onUpdated={() => undefined}
      />,
    )

    // Open Advanced and switch the daemon auth away from dedicated.
    fireEvent.click(await screen.findByRole('button', { name: /advanced/i }))
    const authSelect = screen.getByDisplayValue('Dedicated daemon credentials')
    fireEvent.change(authSelect, { target: { value: 'none' } })

    // Connection → Review → Save.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(providerService.update).toHaveBeenCalledTimes(1))
    const req = vi.mocked(providerService.update).mock.calls[0][1]
    expect(req.credentialsClear).toEqual(
      expect.arrayContaining(['sentinel_username', 'sentinel_password']),
    )
    // Graph auth stayed ON — its credentials are NOT cleared.
    expect(req.credentialsClear).not.toEqual(expect.arrayContaining(['password']))
  })
})
