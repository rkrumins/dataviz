/**
 * The wizard must render a provider type it has never hardcoded anywhere --
 * not in PROVIDER_TYPE_IDS, not in a per-type branch -- as long as the
 * catalog prop describes it. This is PR 3's acceptance test for ArcadeDB,
 * written a PR early: if it passes against a made-up type, a real fifth
 * type needs no wizard changes at all.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { providerVisual, type ProviderTypeEntry } from '@/services/providerTypes'

// Spread the real module: the wizard header renders a <DocsLink>, which is a
// router <Link>, so a one-key factory breaks on mount.
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual<typeof import('react-router-dom')>('react-router-dom'),
  useNavigate: () => vi.fn(),
}))
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
      testConnection: vi.fn().mockResolvedValue({ success: true, latencyMs: 3 }),
    },
  }
})

import { ProviderOnboardingWizard } from '../ProviderOnboardingWizard'
import { providerService } from '@/services/providerService'

// A provider type the wizard bundle has never heard of: absent from
// PROVIDER_TYPE_IDS and from every hardcoded list this task removed.
// `visual` is produced the same way a live catalog row's would be --
// providerVisual() on an id outside PROVIDER_VISUALS -- so this fixture
// exercises the real unknown-type fallback, not a hand-rolled one.
const FAKE_ENTRY: ProviderTypeEntry = {
  id: 'quantumgraph',
  label: 'QuantumGraph',
  description: 'A fictional engine used only to prove the wizard needs no per-type code.',
  docsUrl: null,
  family: 'native',
  capabilities: { writable: true, fullCrud: false, isExternal: true, supportsCopy: false, features: [] },
  connectionShape: {
    kind: 'generic',
    usesHostPort: true,
    defaultPort: 9999,
    tls: 'none',
    auth: 'token',
    databaseField: {
      key: 'database',
      label: 'Database name',
      kind: 'string',
      location: 'extra',
      required: true,
      placeholder: 'my_graph_db',
      help: 'The database or keyspace to connect to.',
    },
    fields: [],
    secretCredentialKeys: ['token'],
    extraConfigKeys: ['database'],
  },
  adminVisible: true,
  visual: providerVisual('quantumgraph'),
}

function renderWizard() {
  return render(
    <MemoryRouter>
      <ProviderOnboardingWizard
        isOpen
        providers={[]}
        providerTypes={[FAKE_ENTRY]}
        onClose={() => undefined}
      />
    </MemoryRouter>,
  )
}

describe('ProviderOnboardingWizard renders a type it has never hardcoded', () => {
  it('shows a card for a catalog-only provider type, and none of the old hardcoded ones', async () => {
    renderWizard()

    expect(await screen.findByRole('button', { name: /quantumgraph/i })).toBeInTheDocument()
    expect(screen.getByText(FAKE_ENTRY.description)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /falkordb/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /neo4j/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /datahub/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /spanner/i })).not.toBeInTheDocument()
  })

  it("selecting it sets the port from the descriptor's default port", async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.click(screen.getByRole('button', { name: /quantumgraph/i }))
    await user.click(screen.getByRole('button', { name: /^next$/i }))

    await screen.findByText(/connect your provider/i)
    const port = screen.getAllByRole('spinbutton')[0]
    expect(port).toHaveValue(9999)
  })

  it('renders connection fields from connectionShape: host/port, its database field, a token -- no username/password', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.click(screen.getByRole('button', { name: /quantumgraph/i }))
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await screen.findByText(/connect your provider/i)

    // usesHostPort: true
    expect(screen.getByPlaceholderText('localhost')).toBeInTheDocument()
    // databaseField, sourced entirely from the descriptor
    expect(screen.getByText('Database name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('my_graph_db')).toBeInTheDocument()
    // auth: 'token' -> one API token input, not the basic username/password pair
    expect(screen.getByText('API token')).toBeInTheDocument()
    expect(screen.queryByText('Username')).not.toBeInTheDocument()
    expect(screen.queryByText('Password')).not.toBeInTheDocument()
    // no FalkorDB-only topology UI for a shape kind that isn't 'falkordb'
    expect(screen.queryByText('Connection topology')).not.toBeInTheDocument()
  })

  it('builds the test-connection payload from the descriptor: database in extraConfig, token in credentials', async () => {
    const testConnection = vi.mocked(providerService.testConnection)
    const user = userEvent.setup()
    renderWizard()

    await user.click(screen.getByRole('button', { name: /quantumgraph/i }))
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await screen.findByText(/connect your provider/i)

    const textboxes = await screen.findAllByRole('textbox')
    await user.type(textboxes[0], 'Quantum Prod')
    await user.type(screen.getByPlaceholderText('localhost'), 'quantum.internal')
    await user.type(screen.getByPlaceholderText('my_graph_db'), 'analytics')
    await user.type(screen.getByPlaceholderText('optional'), 'secret-token')

    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => expect(testConnection).toHaveBeenCalled())
    const payload = testConnection.mock.calls[0][0]
    expect(payload.providerType).toBe('quantumgraph')
    expect(payload.host).toBe('quantum.internal')
    expect(payload.port).toBe(9999)
    expect(payload.extraConfig).toMatchObject({ database: 'analytics' })
    expect(payload.credentials).toEqual({ token: 'secret-token' })
  })
})
