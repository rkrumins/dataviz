import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdminRedis } from './index'

vi.mock('@/services/redisConfigService', () => ({
  fetchRedisConfig: vi.fn().mockResolvedValue({
    roles: [
      {
        role: 'streams', error: null, mode: 'standalone', configured: true,
        host: 'mem-coord.gcp', port: 6379, db: 0,
        username: 'app', hasPassword: true, passwordSource: 'REDIS_STREAMS_PASSWORD_FILE',
        tls: { enabled: true, mutual: true, caCertPath: '/certs/streams/ca.crt',
               verifyMode: 'required', checkHostname: true, filesReadable: true },
        source: { host: 'REDIS_STREAMS_HOST' },
      },
      {
        role: 'cache', error: null, mode: 'standalone', configured: true,
        host: 'mem-cache.gcp', port: 6379, db: 1,
        username: 'cache', hasPassword: true, passwordSource: 'REDIS_CACHE_PASSWORD',
        tls: { enabled: false, mutual: false, filesReadable: null },
        source: { host: 'REDIS_CACHE_HOST' },
        providerOverrides: [{ providerId: 'p1', name: 'acme-prod', host: 'acme-cache' }],
        legacyProviders: [{ providerId: 'p2', name: 'legacy-src' }],
      },
    ],
    deprecations: { REDIS_URL: false, CACHE_REDIS_URL: false, providersOnLegacyCacheUrl: 1 },
  }),
  testRedisRole: vi.fn(),
}))

describe('AdminRedis', () => {
  it('shows both endpoints as independent, with provenance and no secrets', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getByText('mem-coord.gcp:6379')).toBeInTheDocument())
    expect(screen.getByText('mem-cache.gcp:6379')).toBeInTheDocument()
    // provenance is shown, the secret value is not
    expect(screen.getByText(/REDIS_STREAMS_PASSWORD_FILE/)).toBeInTheDocument()
    expect(screen.queryByText(/pw=|password=/i)).not.toBeInTheDocument()
  })

  it('warns about providers still on the legacy cache URL', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getByText(/legacy-src/)).toBeInTheDocument())
  })
})
