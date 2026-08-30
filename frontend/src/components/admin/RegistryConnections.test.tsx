import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RegistryConnections } from './RegistryConnections'
import { useNotificationStore } from '@/components/ui/notifications'

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

// Spread the real module rather than listing exports. A one-key factory
// breaks the moment anything in the tree reaches for another router
// export — which is exactly how <DocsLink> (a router <Link>) took out
// the wizard tests. Not currently in this tree; kept safe on purpose.
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual<typeof import('react-router-dom')>('react-router-dom'),
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

vi.mock('@/store/auth', async () => {
  const actual = await vi.importActual<typeof import('@/store/auth')>('@/store/auth')
  return {
    ...actual,
    // Phase 18 gates the provider write paths (test/edit/delete) behind
    // system:admin. Grant it so the delete flow under test is reachable.
    usePermission: () => true,
  }
})

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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RegistryConnections />
      </QueryClientProvider>
    </MemoryRouter>,
  )
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
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
  })

  /** What the app's ONE notification stack is currently holding. */
  const raised = () => useNotificationStore.getState().notifications

  it('shows the high-level source onboarding guide above the provider empty state', async () => {
    listProviders.mockResolvedValue([])

    renderRegistry()

    await waitFor(() => {
      expect(screen.getByText(/set up your data intelligence platform/i)).toBeInTheDocument()
    })

    expect(screen.getByText(/connect your graph databases, register data sources, and configure semantic layers/i)).toBeInTheDocument()
    expect(screen.getByText(/connect your first provider/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument()
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
    // Nothing was deleted, so nothing may claim it was.
    expect(raised()).toHaveLength(0)
  })

  it('confirms the delete, and says what went with it', async () => {
    // The dialog opens on a "Blast Radius Warning" naming these three by name and
    // then, on success, simply closed. Deleting infrastructure that other people's
    // views depend on is not an action to perform in silence.
    listProviders.mockResolvedValue([sampleProvider])
    getImpact.mockResolvedValue({
      catalogItems: [{ id: 'c1', name: 'orders' }],
      workspaces: [{ id: 'w1', name: 'Sales' }],
      views: [{ id: 'v1', name: 'Order lineage' }],
    })
    deleteProvider.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderRegistry()

    await waitFor(() => expect(screen.getByText(/warehouse graph/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /delete provider warehouse graph/i }))
    await waitFor(() => expect(getImpact).toHaveBeenCalledWith(sampleProvider.id))

    await user.type(screen.getByPlaceholderText(sampleProvider.name), sampleProvider.name)
    await user.click(screen.getByRole('button', { name: /^delete provider$/i }))

    await waitFor(() => expect(raised()).toHaveLength(1))
    expect(raised()[0].type).toBe('success')
    expect(raised()[0].message).toBe(
      'Deleted \u201cWarehouse Graph\u201d and the 3 assets that depended on it.')
  })

  it('does not claim a blast radius when there was none', async () => {
    listProviders.mockResolvedValue([sampleProvider])
    deleteProvider.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderRegistry()

    await waitFor(() => expect(screen.getByText(/warehouse graph/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /delete provider warehouse graph/i }))
    await waitFor(() => expect(getImpact).toHaveBeenCalledWith(sampleProvider.id))

    await user.type(screen.getByPlaceholderText(sampleProvider.name), sampleProvider.name)
    await user.click(screen.getByRole('button', { name: /^delete provider$/i }))

    await waitFor(() => expect(raised()).toHaveLength(1))
    expect(raised()[0].message).toBe(
      'Deleted \u201cWarehouse Graph\u201d. Nothing else depended on it.')
  })

  it('claims nothing about dependents when the blast-radius probe failed', async () => {
    // A failed getImpact leaves the dialog showing NEITHER the "Blast Radius
    // Warning" nor "Safe to delete" \u2014 nobody knows what depended on this
    // provider, least of all the notification. "Nothing else depended on it"
    // would be an assertion the app never established.
    listProviders.mockResolvedValue([sampleProvider])
    getImpact.mockRejectedValue(new Error('impact query timed out'))
    deleteProvider.mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderRegistry()

    await waitFor(() => expect(screen.getByText(/warehouse graph/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /delete provider warehouse graph/i }))
    await waitFor(() => expect(getImpact).toHaveBeenCalledWith(sampleProvider.id))

    await user.type(screen.getByPlaceholderText(sampleProvider.name), sampleProvider.name)
    await user.click(screen.getByRole('button', { name: /^delete provider$/i }))

    await waitFor(() => expect(raised()).toHaveLength(1))
    expect(raised()[0].type).toBe('success')
    expect(raised()[0].message).toBe('Deleted \u201cWarehouse Graph\u201d.')
    expect(raised()[0].message).not.toMatch(/depended on it/)
  })
})
