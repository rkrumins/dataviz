/**
 * Saving an edit that moves a provider other versioned graphs are projected into: the wizard
 * lists the graphs the server named and saves again with `confirmReseed` only when asked.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

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
      update: vi.fn(),
    },
  }
})

import { ProviderOnboardingWizard } from '../ProviderOnboardingWizard'
import { providerService, VersionedGraphsPinnedError } from '@/services/providerService'
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

describe('ProviderOnboardingWizard edit that moves pinned versioned graphs', () => {
  it('lists the graphs and saves again with confirmReseed only when asked', async () => {
    const update = vi.mocked(providerService.update)
    update.mockRejectedValueOnce(new VersionedGraphsPinnedError(
      '1 versioned graph(s) are projected into this provider.',
      [{ id: 'g1', name: 'customer360', type: 'versioned_graph' }],
    ))
    update.mockResolvedValueOnce({ ...PROVIDER })
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <ProviderOnboardingWizard
          isOpen
          mode="edit"
          provider={PROVIDER}
          providers={[PROVIDER]}
          onClose={onClose}
          onCreated={() => undefined}
          onUpdated={() => undefined}
        />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }))

    expect(await screen.findByText('customer360')).toBeTruthy()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][2]).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /save and reseed/i }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls[1][2]).toEqual({ confirmReseed: true })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
