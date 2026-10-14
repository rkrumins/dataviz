/**
 * Saved filters are one click away only if the pill knows when it is on screen,
 * saving sends the filters in their canonical spelling, and a refusal from the
 * server is shown where the name was typed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/savedViewFiltersService', () => ({
  listSavedViewFilters: vi.fn(),
  createSavedViewFilter: vi.fn(),
  updateSavedViewFilter: vi.fn(),
  reorderSavedViewFilters: vi.fn(),
  deleteSavedViewFilter: vi.fn(),
}))

import {
  createSavedViewFilter, deleteSavedViewFilter, listSavedViewFilters, type SavedViewFilter,
} from '@/services/savedViewFiltersService'
import { SavedFilterPills } from '../components/SavedFilterPills'
import { EMPTY_FILTERS, type ViewFilterState } from '../model'
import type { FilterLookups } from '../dimensions'

const LOOKUPS: FilterLookups = {
  today: '2026-10-12', workspaceName: () => undefined, dataSourceName: () => undefined,
  personName: () => undefined, viewTypeLabel: t => t,
}

const row = (id: string, name: string, query: string, position: number): SavedViewFilter => ({
  id, name, query, position, createdAt: '', updatedAt: '',
})

function renderPills(state: ViewFilterState, sort: string | null = null) {
  const onApply = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SavedFilterPills state={state} sort={sort} lookups={LOOKUPS} onApply={onApply} />
    </QueryClientProvider>,
  )
  return { onApply }
}

beforeEach(() => {
  vi.mocked(listSavedViewFilters).mockReset()
  vi.mocked(createSavedViewFilter).mockReset()
  vi.mocked(deleteSavedViewFilter).mockReset()
})

describe('SavedFilterPills', () => {
  it('lights the pill whose filters are on screen, however its link spelled them', async () => {
    vi.mocked(listSavedViewFilters).mockResolvedValue([
      row('a', 'Finance', 'tag=finance&sourceKind=versioned', 0),
      row('b', 'Mine', 'contributor=me', 1),
    ])
    const { onApply } = renderPills({ ...EMPTY_FILTERS, sourceKind: 'versioned', tags: ['finance'] })
    const on = await screen.findByRole('button', { name: 'Finance' })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('false')
    // Already saved: nothing to save.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    expect(onApply).toHaveBeenCalledWith('contributor=me')
  })

  it('saves the filters and the chosen sort under a suggested name', async () => {
    vi.mocked(listSavedViewFilters).mockResolvedValue([])
    vi.mocked(createSavedViewFilter).mockImplementation(async body => row('n', body.name, body.query, 0))
    renderPills({ ...EMPTY_FILTERS, updated: '7d', sourceKind: 'external' }, 'name-asc')
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    const input = screen.getByRole('textbox', { name: 'Save these filters' }) as HTMLInputElement
    expect(input.value).toBe('External · Updated past 7 days')
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(createSavedViewFilter).toHaveBeenCalled())
    expect(vi.mocked(createSavedViewFilter).mock.calls[0][0]).toEqual({
      name: 'External · Updated past 7 days', query: 'sort=name-asc&sourceKind=external&updated=7d',
    })
  })

  it("shows the server's refusal where the name was typed", async () => {
    vi.mocked(listSavedViewFilters).mockResolvedValue([])
    vi.mocked(createSavedViewFilter).mockRejectedValue(
      Object.assign(new Error('You already have a saved filter called "Mine".'), { status: 409 }),
    )
    renderPills({ ...EMPTY_FILTERS, tags: ['pii'] })
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    fireEvent.submit(screen.getByRole('textbox', { name: 'Save these filters' }).closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toBe('You already have a saved filter called "Mine".')
  })

  it('stays out of the way with nothing saved and nothing filtered', async () => {
    vi.mocked(listSavedViewFilters).mockResolvedValue([])
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SavedFilterPills state={EMPTY_FILTERS} sort={null} lookups={LOOKUPS} onApply={() => {}} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(listSavedViewFilters).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
