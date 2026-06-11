import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProviderOnboardingWizard } from './ProviderOnboardingWizard'
import { providerService } from '@/services/providerService'

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/services/providerService', async () => {
  const actual = await vi.importActual<typeof import('@/services/providerService')>('@/services/providerService')
  return {
    ...actual,
    providerService: {
      ...actual.providerService,
      testConnection: vi.fn(),
    },
  }
})

function renderWizard() {
  return render(
    <ProviderOnboardingWizard
      isOpen
      providers={[]}
      onClose={() => undefined}
    />,
  )
}

async function moveToReviewStep() {
  const user = userEvent.setup()
  renderWizard()

  await user.click(screen.getByRole('button', { name: /falkordb/i }))
  await user.click(screen.getByRole('button', { name: /^next$/i }))

  await screen.findByText(/connect your provider/i)
  const textboxes = await screen.findAllByRole('textbox')
  await user.type(textboxes[0], 'Warehouse Graph')
  await user.type(textboxes[1], 'graph.internal')
  // Port is the first spinbutton; the FalkorDB topology section adds more
  // (socket timeout, pool size), so target by DOM order rather than uniqueness.
  const portInput = screen.getAllByRole('spinbutton')[0]
  await user.clear(portInput)
  await user.type(portInput, '6379')
  await user.click(screen.getByRole('button', { name: /^next$/i }))

  return user
}

describe('ProviderOnboardingWizard connectivity checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a successful connectivity state before enabling provider creation', async () => {
    vi.mocked((providerService as any).testConnection).mockResolvedValue({
      success: true,
      latencyMs: 42.5,
    })

    const user = await moveToReviewStep()

    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create provider/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/connected successfully/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/42.5ms/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument()
  })

  it('shows a failed connectivity warning but still allows provider creation', async () => {
    vi.mocked((providerService as any).testConnection).mockResolvedValue({
      success: false,
      error: 'Connection refused',
    })

    const user = await moveToReviewStep()
    await user.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/unable to connect/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/connection refused/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument()
  })

  it('serializes FalkorDB cluster topology into the test-connection request', async () => {
    const testConnection = vi.mocked((providerService as any).testConnection)
    testConnection.mockResolvedValue({ success: true, latencyMs: 5 })

    const user = userEvent.setup()
    renderWizard()
    await user.click(screen.getByRole('button', { name: /falkordb/i }))
    await user.click(screen.getByRole('button', { name: /^next$/i }))

    await screen.findByText(/connect your provider/i)
    const textboxes = await screen.findAllByRole('textbox')
    await user.type(textboxes[0], 'Cluster Graph')

    // Switch topology to cluster and add one startup node.
    await user.selectOptions(screen.getByRole('combobox'), 'cluster')
    await user.click(screen.getByRole('button', { name: /add node/i }))
    const hostInputs = await screen.findAllByPlaceholderText('host')
    await user.type(hostInputs[hostInputs.length - 1], 'node-a')
    const portInputs = screen.getAllByPlaceholderText('port')
    await user.clear(portInputs[portInputs.length - 1])
    await user.type(portInputs[portInputs.length - 1], '7001')

    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => expect(testConnection).toHaveBeenCalled())
    const payload = testConnection.mock.calls[0][0]
    expect(payload.extraConfig.falkordbConnection.mode).toBe('cluster')
    expect(payload.extraConfig.falkordbConnection.cluster.startupNodes).toEqual([
      ['node-a', 7001],
    ])
  })
})
