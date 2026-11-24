/**
 * A workspace's views on the Usage tab: the count is the server's total and the
 * list pages on, instead of stopping at the list's first page of 50.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { View, ViewListResponse } from '@/services/viewApiService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

const listViews = vi.fn()
vi.mock('@/services/viewApiService', () => ({ listViews: (...a: unknown[]) => listViews(...a) }))
vi.mock('../../hooks/useOntologies', () => ({
  useOntologyAssignments: () => ({
    data: [{ workspaceId: 'ws_fin', workspaceName: 'Finance', dataSourceId: 'ds_1', dataSourceLabel: 'Warehouse' }],
    isLoading: false,
  }),
}))
vi.mock('../EducationalCallout', () => ({ EducationalCallout: () => null }))

import { UsagePanel } from './UsagePanel'

const TOTAL = 120

function page(offset: number, limit: number): ViewListResponse {
  const end = Math.min(offset + limit, TOTAL)
  const items = Array.from({ length: end - offset }, (_, i) => ({
    id: `v${offset + i}`, name: `View ${offset + i}`, viewType: 'graph', workspaceId: 'ws_fin',
  }) as unknown as View)
  return { items, total: TOTAL, hasMore: end < TOTAL, nextOffset: end < TOTAL ? end : null }
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UsagePanel
          ontology={{ id: 'ont_1', entityTypeDefinitions: {}, relationshipTypeDefinitions: {} } as unknown as OntologyDefinitionResponse}
          workspaces={[]}
          ontologies={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('UsagePanel — a workspace’s views', () => {
  beforeEach(() => {
    listViews.mockReset()
    listViews.mockImplementation(async ({ offset = 0, limit = 50 }: { offset?: number; limit?: number }) => page(offset, limit))
  })

  it('asks for nothing until the views are opened', () => {
    renderPanel()
    expect(listViews).not.toHaveBeenCalled()
  })

  it('shows the true total and loads on past the first page', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: /views/i }))

    // The badge is the server's total, not the 50 rows of the first page.
    expect(await screen.findByText('120')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^View \d+/ })).toHaveLength(50)
    expect(screen.getByText('Showing 50 of 120')).toBeInTheDocument()
    expect(listViews).toHaveBeenLastCalledWith({ workspaceId: 'ws_fin', limit: 50, offset: 0 })

    await user.click(screen.getByRole('button', { name: 'Show 50 more' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^View \d+/ })).toHaveLength(100))
    expect(listViews).toHaveBeenLastCalledWith({ workspaceId: 'ws_fin', limit: 50, offset: 50 })

    // The last page is only what is left, and then there is nothing more to load.
    await user.click(screen.getByRole('button', { name: 'Show 20 more' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^View \d+/ })).toHaveLength(120))
    expect(screen.queryByRole('button', { name: /more$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^View 119/ })).toBeInTheDocument()
  })

  it('says when the views could not be loaded, and retries', async () => {
    listViews.mockRejectedValueOnce(new Error('down'))
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: /views/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load this workspace’s views.')
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText('120')).toBeInTheDocument()
  })
})
