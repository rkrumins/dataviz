/**
 * SourceMappingSection — alias table rendering + Keep/Split wiring.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const getSourceMappings = vi.fn()
vi.mock('@/services/ontologyDefinitionService', () => ({
  ontologyDefinitionService: { getSourceMappings: (...a: unknown[]) => getSourceMappings(...a) },
}))

const confirmVariant = vi.fn()
vi.mock('@/components/admin/workspace/VocabAlignmentWarning', () => ({
  confirmVariant: (...a: unknown[]) => confirmVariant(...a),
}))

import { SourceMappingSection } from './SourceMappingSection'

const ROW = {
  workspaceId: 'ws1',
  workspaceName: 'Prod',
  dataSourceId: 'ds1',
  dataSourceLabel: 'Falkor Main',
  hasProfile: true,
  hasDrift: true,
  lastSeenAt: '2026-07-16T00:00:00Z',
  entityMappings: { Server: { observed: 'server', auto: true } },
  relationshipMappings: { HAS: { observed: 'HAS', auto: false } },
  driftDetails: [
    { declared: 'HAS', observed: ['has', 'Has'], dimension: 'relationship' as const, kind: 'multi_variant', needsConfirmation: true },
  ],
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SourceMappingSection ontologyId="bp_1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getSourceMappings.mockReset().mockResolvedValue([ROW])
  confirmVariant.mockReset().mockResolvedValue(undefined)
})

describe('SourceMappingSection', () => {
  it('renders the alias table with drift/exact chips and auto/confirmed badges', async () => {
    renderSection()

    expect(await screen.findByText('Falkor Main')).toBeInTheDocument()
    // Entity: declared Server ← observed "server" (case drift → amber chip content)
    expect(screen.getByText('Server')).toBeInTheDocument()
    expect(screen.getByText('server')).toBeInTheDocument()
    // Badges: entity auto, relationship confirmed
    expect(screen.getByText('auto')).toBeInTheDocument()
    expect(screen.getByText('confirmed')).toBeInTheDocument()
    // Pending decision banner
    expect(screen.getByText(/1 decision pending/)).toBeInTheDocument()
  })

  it('fires the confirm route with the row context on Keep merged', async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('Falkor Main')

    await user.click(screen.getByText('Keep merged'))
    await waitFor(() => expect(confirmVariant).toHaveBeenCalledWith('ws1', 'ds1', 'HAS', true, 'relationship'))
  })

  it('renders nothing when the ontology has no assigned sources', async () => {
    getSourceMappings.mockResolvedValue([])
    const { container } = renderSection()
    await waitFor(() => expect(getSourceMappings).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).not.toContain('Source Vocabulary Mappings'))
  })
})
