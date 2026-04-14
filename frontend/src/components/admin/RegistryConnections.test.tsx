import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RegistryConnections } from './RegistryConnections'

const {
  listProviders,
  getImpact,
  deleteProvider,
  testProvider,
  listStatus,
  setHealth,
  refreshHealth,
  testOne,
} = vi.hoisted(() => ({
  listProviders: vi.fn(),
  getImpact: vi.fn(),
  deleteProvider: vi.fn(),
  testProvider: vi.fn(),
  listStatus: vi.fn(),
  setHealth: vi.fn(),
  refreshHealth: vi.fn(),
  testOne: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/useProviderHealthSweep', () => ({
  useProviderHealthSweep: () => ({
    healthMap: {},
    testOne,
    refresh: refreshHealth,
    setHealth,
  }),
}))

vi.mock('@/services/providerService', async () => {
  const actual = await vi.importActual<typeof import('@/services/providerService')>('@/services/providerService')
  return {
    ...actual,
    providerService: {
      ...actual.providerService,
      list: listProviders,
      getImpact,
      delete: deleteProvider,
      test: testProvider,
      listStatus,
    },
  }
})

vi.mock('./ProviderOnboardingWizard', () => ({
  ProviderOnboardingWizard: () => null,
}))

const sampleProvider = {
  id: 'prov_1',
  name: 'Warehouse Graph',
  providerType: 'falkordb' as const,
  host: 'graph.internal',
  port: 6379,
  tlsEnabled: false,
  isActive: true,
  permittedWorkspaces: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
}

function renderRegistry() {
  return render(<RegistryConnections />)
}

describe('RegistryConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listStatus.mockResolvedValue([])
    testProvider.mockResolvedValue({ success: true, latencyMs: 10 })
    refreshHealth.mockResolvedValue(undefined)
    testOne.mockResolvedValue(undefined)
    setHealth.mockReturnValue(undefined)
    getImpact.mockResolvedValue({ catalogItems: [], workspaces: [], views: [] })
  })

  it('shows the high-level source onboarding guide above the provider empty state', async () => {
    listProviders.mockResolvedValue([])

    renderRegistry()

    await waitFor(() => {
      expect(screen.getByText(/set up your data intelligence platform/i)).toBeInTheDocument()
    })

    expect(screen.getByText(/connect your graph databases, register data sources, and configure semantic layers/i)).toBeInTheDocument()
    expect(screen.getByText(/connect your first provider/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start provider onboarding/i })).toBeInTheDocument()
  })

  it('keeps the delete dialog open and shows the delete error to the user', async () => {
    listProviders.mockResolvedValue([sampleProvider])
    deleteProvider.mockRejectedValue(new Error('Provider is still referenced by existing assets'))

    const user = userEvent.setup()
    renderRegistry()

    await waitFor(() => {
      expect(screen.getByText(/warehouse graph/i)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /delete provider warehouse graph/i }))

    await waitFor(() => {
      expect(getImpact).toHaveBeenCalledWith(sampleProvider.id)
    })

    await user.type(
      screen.getByPlaceholderText(sampleProvider.name),
      sampleProvider.name,
    )
    await user.click(screen.getByRole('button', { name: /^delete provider$/i }))

    await waitFor(() => {
      expect(screen.getByText(/provider is still referenced by existing assets/i)).toBeInTheDocument()
    })

    expect(screen.getByRole('heading', { name: /delete provider/i })).toBeInTheDocument()
  })
})
