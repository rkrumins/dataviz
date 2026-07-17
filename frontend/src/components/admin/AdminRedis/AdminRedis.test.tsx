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
      {
        role: 'falkordb', error: null, mode: 'sentinel', configured: true,
        host: 'falkordb.internal', port: 6379,
        sentinelMaster: 'mymaster', sentinelNodes: ['s1:26379', 's2:26379'],
        clusterNodes: [],
        username: null, hasPassword: true, passwordSource: 'FALKORDB_PASSWORD_FILE',
        sentinelUsername: 'sd-user', hasSentinelPassword: true,
        sentinelPasswordSource: 'FALKORDB_SENTINEL_PASSWORD', sentinelAuthEnabled: false,
        tls: { enabled: true, mutual: false, caCertPath: '/certs/falkordb/ca.crt',
               verifyMode: 'required', checkHostname: true, filesReadable: true },
        sentinelTls: { inherited: false, enabled: false, mutual: false, filesReadable: null },
        addressRemap: [{ from: '10.0.0.5:6379', to: 'edge.example.com:6379' }],
        source: { host: 'FALKORDB_HOST', sentinel_master: 'FALKORDB_SENTINEL_MASTER' },
        providerGraphs: [{ providerId: 'p3', name: 'prod-graph', host: 'g1', mode: 'cluster' }],
      },
    ],
    deprecations: { REDIS_URL: false, CACHE_REDIS_URL: false, providersOnLegacyCacheUrl: 1 },
  }),
  testRedisRole: vi.fn(),
}))

describe('AdminRedis', () => {
  it('shows both endpoints as independent, with provenance and no secrets', async () => {
    render(<AdminRedis />)
    // The page covers all Redis-protocol endpoints incl. the default graph store.
    expect(screen.getByText('Redis & Graph Store')).toBeInTheDocument()
    // Each endpoint is shown at least once (the cache endpoint appears both on its
    // role card and in the "shared default" provider-impact panel — both meaningful).
    await waitFor(() => expect(screen.getAllByText('mem-coord.gcp:6379').length).toBeGreaterThan(0))
    expect(screen.getAllByText('mem-cache.gcp:6379').length).toBeGreaterThan(0)
    // provenance is shown (as the password's source chip, and in the env reference),
    // the secret value itself never is
    expect(screen.getAllByText(/REDIS_STREAMS_PASSWORD_FILE/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/pw=|password=/i)).not.toBeInTheDocument()
  })

  it('warns about providers still on the legacy cache URL', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getByText(/legacy-src/)).toBeInTheDocument())
  })

  it('renders the FalkorDB graph role card with sentinel-daemon auth, remap and provider list', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getAllByText('falkordb.internal:6379').length).toBeGreaterThan(0))
    // Sentinel-daemon auth is its own visible fact (a daemon-auth mismatch
    // reads as a whole-tier outage — it must be diagnosable here).
    expect(screen.getByText('dedicated credentials')).toBeInTheDocument()
    expect(screen.getByText('sd-user')).toBeInTheDocument()
    // Cross-cluster remap pairs are shown from→to.
    expect(screen.getByText('10.0.0.5:6379')).toBeInTheDocument()
    expect(screen.getByText('→ edge.example.com:6379')).toBeInTheDocument()
    // Provider-routed instances are listed as SEPARATE endpoints, each
    // linking to the provider page where they are actually configured.
    const chip = screen.getByText(/prod-graph/).closest('a')
    expect(chip).toHaveAttribute('href', '/ingestion?tab=providers')
    // No secret anywhere.
    expect(screen.queryByText(/sd-secret|graph-secret/)).not.toBeInTheDocument()
  })
})
