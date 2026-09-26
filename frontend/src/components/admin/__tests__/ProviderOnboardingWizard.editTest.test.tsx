/**
 * Edit mode must offer a PRE-SAVE connectivity test of the PENDING payload:
 * the per-row Test button on the provider list probes the last SAVED row
 * (`/{id}/test`), so without this the only way to validate an edit was to
 * save it first. The wizard's inline test posts the full candidate config to
 * `/test-connection` (nothing persisted).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

// Spread the real module: the wizard header renders a <DocsLink>, which
// is a router <Link>, so a one-key factory breaks on mount.
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual<typeof import('react-router-dom')>('react-router-dom'),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/store/branding', () => ({ useBrand: () => ({ appName: 'Test' }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/services/redisConfigService', () => ({
  fetchRedisConfig: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/services/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/providerService')>()
  return {
    ...actual,
    providerService: {
      ...actual.providerService,
      testConnection: vi.fn().mockResolvedValue({ success: true, latencyMs: 12 }),
      test: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  }
})

import { ProviderOnboardingWizard } from '../ProviderOnboardingWizard'
import { providerService } from '@/services/providerService'
import type { ProviderResponse } from '@/services/providerService'

const PROVIDER = {
  id: 'prov_edit',
  name: 'graph',
  providerType: 'falkordb',
  host: 'falkordb.other-cluster.svc',
  port: 6379,
  tlsEnabled: false,
  isActive: true,
  authConfigured: false,
  cacheAuthConfigured: false,
  extraConfig: {},
} as unknown as ProviderResponse

describe('ProviderOnboardingWizard edit-mode connectivity test', () => {
  it('review step exposes a pending-payload test that calls /test-connection', async () => {
    render(
      <MemoryRouter>
        <ProviderOnboardingWizard
          isOpen
          mode="edit"
          provider={PROVIDER}
          providers={[PROVIDER]}
          onClose={() => undefined}
          onCreated={() => undefined}
          onUpdated={() => undefined}
        />
      </MemoryRouter>,
    )

    // Edit mode starts on Connection; FalkorDB flow: Connection → Review.
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }))

    const testButton = await screen.findByRole('button', {
      name: /test pending settings/i,
    })
    fireEvent.click(testButton)

    await waitFor(() => {
      expect(providerService.testConnection).toHaveBeenCalledTimes(1)
    })
    // It tested the SUBMITTED (pending) payload — not the saved row.
    expect(providerService.test).not.toHaveBeenCalled()
    const req = vi.mocked(providerService.testConnection).mock.calls[0][0]
    expect(req.host).toBe('falkordb.other-cluster.svc')
    expect(req.providerType).toBeTruthy()
  })
})
