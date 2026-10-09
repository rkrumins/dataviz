/**
 * AddDataSourceWizard — its Semantics step, through the shared match list (OntologyMatchList, also
 * used by a view package's new data source). Pinned here: the graph is profiled and every layer
 * scored, the best fit that covers anything is chosen for the person and carried to the review
 * with its coverage, and "System defaults" attaches no layer at all.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { ProviderResponse } from '@/services/providerService'

const statsMock = vi.fn()
const suggestMock = vi.fn()
const addMock = vi.fn()

vi.mock('@/services/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/providerService')>()
  return { ...actual, providerService: { ...actual.providerService, getAssetStats: (...a: unknown[]) => statsMock(...a) } }
})
vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ontologyDefinitionService')>()
  return {
    ...actual,
    ontologyDefinitionService: { ...actual.ontologyDefinitionService, suggest: (...a: unknown[]) => suggestMock(...a) },
  }
})
vi.mock('@/services/catalogService', () => ({ catalogService: { listWithBindings: () => new Promise(() => {}) } }))
vi.mock('@/services/workspaceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspaceService')>()
  return { ...actual, workspaceService: { ...actual.workspaceService, addDataSource: (...a: unknown[]) => addMock(...a) } }
})
vi.mock('@/components/dataSource/NodeIdentity', () => ({
  NodeIdentityField: () => null, isIdentityOverridden: () => false, isNameOverridden: () => false,
}))

import { AddDataSourceWizard } from '../AddDataSourceWizard'

const layer = (id: string, name: string) => ({
  id, name, version: 2, description: null, isPublished: true, entityTypeDefinitions: {}, relationshipTypeDefinitions: {},
}) as unknown as OntologyDefinitionResponse
const ONTOLOGIES = [layer('o_ops', 'Operations'), layer('o_fin', 'Finance')]
const score = (ontologyId: string, jaccardScore: number) => ({
  ontologyId, ontologyName: ontologyId, version: 2, jaccardScore,
  coveredEntityTypes: jaccardScore > 0 ? ['dataset'] : [], uncoveredEntityTypes: jaccardScore > 0 ? ['job'] : ['dataset', 'job'],
  coveredRelationshipTypes: [], uncoveredRelationshipTypes: ['PRODUCES'], totalEntityTypes: 2, totalRelationshipTypes: 1,
})

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AddDataSourceWizard isOpen workspaceId="ws1" workspaceName="UAT" onClose={vi.fn()} onAdded={vi.fn()}
          catalogItems={[{ id: 'c1', providerId: 'p1', name: 'lineage', sourceIdentifier: 'lineage_graph' }]}
          providers={[{ id: 'p1', name: 'Falkor', providerType: 'falkordb' } as ProviderResponse]}
          ontologies={ONTOLOGIES} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  statsMock.mockResolvedValue({
    data: { nodeCount: 10, edgeCount: 4, entityTypeCounts: { dataset: 8, job: 2 }, edgeTypeCounts: { PRODUCES: 4 } },
    meta: { status: 'ready' },
  })
  suggestMock.mockResolvedValue({ suggested: { name: 'x' }, matchingOntologies: [score('o_ops', 0), score('o_fin', 0.5)], mergedVariants: {} })
  addMock.mockResolvedValue({})
})

describe('AddDataSourceWizard — semantics', () => {
  it('scores every layer against the graph, chooses the best fit, and attaches it', async () => {
    renderWizard()
    fireEvent.click(screen.getByText('lineage'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('BEST FIT')).toBeInTheDocument()
    expect(statsMock).toHaveBeenCalledWith('p1', 'lineage_graph')
    expect(suggestMock.mock.calls[0][2]).toBe(0)
    expect(screen.getByText('No overlap with this graph\'s types')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('v2 · covers 33% of this graph\'s types')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add data source/ }))
    await waitFor(() => expect(addMock).toHaveBeenCalledWith('ws1', expect.objectContaining({ catalogItemId: 'c1', ontologyId: 'o_fin' })))
  })

  it('attaches no layer when System defaults is chosen', async () => {
    renderWizard()
    fireEvent.click(screen.getByText('lineage'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('BEST FIT')
    fireEvent.click(screen.getByText('System defaults'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add data source/ }))
    await waitFor(() => expect(addMock).toHaveBeenCalledWith('ws1', expect.objectContaining({ ontologyId: undefined })))
  })
})
