/**
 * SearchViewChip — a subset view says so in its header and opens what it shows,
 * where its layers come from, and what an editor can change. SubsetsChip — a base
 * view says how many subsets are made from it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchViewStatus, SubsetList } from '@/types/searchView'

const api = {
  getSearchStatus: vi.fn<(viewId: string) => Promise<SearchViewStatus>>(),
  putSearch: vi.fn(),
  listSubsets: vi.fn<(viewId: string) => Promise<SubsetList>>(),
}
vi.mock('@/services/searchViewsApi', () => ({
  SEARCH_VIEW_QUERY_KEY: 'view-search',
  SUBSETS_QUERY_KEY: 'view-subsets',
  getSearchStatus: (id: string) => api.getSearchStatus(id),
  putSearch: (...a: unknown[]) => api.putSearch(...a),
  listSubsets: (id: string) => api.listSubsets(id),
}))
vi.mock('@/services/viewApiService', () => ({ getView: vi.fn().mockResolvedValue(null), viewToViewConfig: (v: unknown) => v }))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
// What the chip tells the user, with the action it offers.
const notify = vi.fn<(tone: string, message: string, action?: { label: string; onClick: () => void }) => void>()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { SearchViewChip, SubsetsChip } from '../SearchViewChip'

function status(over: Partial<SearchViewStatus> = {}): SearchViewStatus {
  return {
    definition: { v: 1, predicate: { kind: 'tag', values: ['pii'] } as never, within: 'view', readIn: 'v-base', layout: 'inherit' },
    definitionHash: 'h1',
    status: 'ok',
    base: { viewId: 'v-base', name: 'Sales overview', available: true },
    layers: [{ id: 'l1', name: 'Tables', entityTypes: ['table'], rest: false, excludedTypes: [] }],
    placedByType: false,
    ...over,
  } as SearchViewStatus
}

const SUBSET = { id: 'v9', name: 'PII', config: { search: { v: 1 } } } as never
const BASE = { id: 'v-base', name: 'Sales overview', config: {} } as never

function renderIn(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

describe('SearchViewChip', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    api.getSearchStatus.mockResolvedValue(status())
    api.putSearch.mockResolvedValue(status({ definitionHash: 'h2' }))
  })

  it('names its base, and opens what it shows and where its layers come from', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByText(/Shows the matches of/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sales overview' })).toHaveAttribute('href', '/views/v-base')
    expect(screen.getByText(/followed as they change/)).toBeInTheDocument()
  })

  it('an editor gives it a layout of its own, against the hash it read', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Make its own layout/ }))
    await waitFor(() => expect(api.putSearch).toHaveBeenCalledWith('v9', { ifDefinitionHash: 'h1', layout: 'own' }))
  })

  it('an own layout can follow its base again', async () => {
    api.getSearchStatus.mockResolvedValue(status({
      definition: { ...status().definition, layout: 'own' },
    }))
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByText('It has a layout of its own.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Follow Sales overview again/ }))
    await waitFor(() => expect(api.putSearch).toHaveBeenCalledWith('v9', { ifDefinitionHash: 'h1', layout: 'inherit' }))
  })

  it('Edit search… opens it where the matches are looked for — not where the base can’t be opened', async () => {
    const onEditSearch = vi.fn()
    const { unmount } = renderIn(<SearchViewChip view={SUBSET} canEdit onEditSearch={onEditSearch} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Edit search…/ }))
    expect(onEditSearch).toHaveBeenCalledWith(expect.objectContaining({ definitionHash: 'h1' }))
    unmount()

    api.getSearchStatus.mockResolvedValue(status({ base: { viewId: 'v-base', name: null, available: true } }))
    renderIn(<SearchViewChip view={SUBSET} canEdit onEditSearch={onEditSearch} />)
    fireEvent.click(await screen.findByRole('button', { name: /Subset of a view you can’t open/ }))
    expect(await screen.findByText(/changed in its base view, which you can’t open/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit search…/ })).not.toBeInTheDocument()
  })

  it('a deleted base says so, and offers nothing that needs it', async () => {
    api.getSearchStatus.mockResolvedValue(status({ status: 'base_missing' }))
    renderIn(<SearchViewChip view={SUBSET} canEdit onEditSearch={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset · base view gone' }))
    expect(await screen.findByText(/Its base view was deleted/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit search…/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument()
  })

  it('readers see it, and nothing to change it with', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit={false} onEditSearch={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByText(/Only someone who can edit this view/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Make its own layout/ })).not.toBeInTheDocument()
  })

  it('renders nothing for an ordinary view, and asks nothing', () => {
    const { container } = renderIn(<SearchViewChip view={BASE} canEdit />)
    expect(container).toBeEmptyDOMElement()
    expect(api.getSearchStatus).not.toHaveBeenCalled()
  })
})

describe('SearchViewChip — what it keeps, and fewer layers', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    notify.mockReset()
    api.getSearchStatus.mockResolvedValue(status({
      layers: [
        { id: 'l1', name: 'Tables', entityTypes: ['table'], rest: false, excludedTypes: [] },
        { id: 'l2', name: 'Dashboards', entityTypes: ['dashboard'], rest: false, excludedTypes: [], hidden: true },
      ],
      definition: { ...status().definition, hiddenLayers: ['l2'] } as never,
    }))
    api.putSearch.mockResolvedValue(status({ definitionHash: 'h2' }))
  })

  it('an editor keeps what the matches reach with one tap', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Everything inside/ }))
    await waitFor(() => expect(api.putSearch).toHaveBeenCalledWith('v9', {
      ifDefinitionHash: 'h1', include: { contents: true, containers: false, upstream: false, downstream: false } }))
  })

  it('an editor keeps a number of levels inside them, with Undo', async () => {
    api.getSearchStatus.mockResolvedValue(status({ definition: { ...status().definition,
      include: { contents: true, containers: false, upstream: false, downstream: false } } }))
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    const inside = await screen.findByRole('radiogroup', { name: 'Levels inside them' })
    expect(screen.queryByRole('radiogroup', { name: 'Levels up' })).toBeNull()
    expect(within(inside).getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(inside).getByRole('radio', { name: '2' }))
    await waitFor(() => expect(api.putSearch).toHaveBeenCalledWith('v9', { ifDefinitionHash: 'h1',
      include: { contents: true, contentsLevels: 2, containers: false, upstream: false, downstream: false } }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', 'It keeps two levels inside them now',
      expect.objectContaining({ label: 'Undo' }), 8000))
    notify.mock.calls.at(-1)![2]!.onClick()
    await waitFor(() => expect(api.putSearch).toHaveBeenLastCalledWith('v9', { ifDefinitionHash: 'h2',
      include: { contents: true, containers: false, upstream: false, downstream: false } }))
  })

  it('an editor keeps what contains them up to the top again, and Undo brings back the parent alone', async () => {
    api.getSearchStatus.mockResolvedValue(status({ definition: { ...status().definition,
      include: { contents: false, containers: true, containersLevels: 1, upstream: false, downstream: false } } }))
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByText(/what contains them, one level up/)).toBeInTheDocument()
    const up = screen.getByRole('radiogroup', { name: 'Levels up' })
    expect(within(up).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Parent', '2', '3', 'Top'])
    expect(within(up).getByRole('radio', { name: 'Parent' })).toHaveAttribute('aria-checked', 'true')
    // What it keeps already: nothing to save.
    fireEvent.click(within(up).getByRole('radio', { name: 'Parent' }))
    fireEvent.click(within(up).getByRole('radio', { name: 'Top' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', 'It keeps what contains them now',
      expect.objectContaining({ label: 'Undo' }), 8000))
    expect(api.putSearch).toHaveBeenCalledTimes(1)
    expect(api.putSearch).toHaveBeenCalledWith('v9', { ifDefinitionHash: 'h1',
      include: { contents: false, containers: true, upstream: false, downstream: false } })
    notify.mock.calls.at(-1)![2]!.onClick()
    await waitFor(() => expect(api.putSearch).toHaveBeenLastCalledWith('v9', { ifDefinitionHash: 'h2',
      include: { contents: false, containers: true, containersLevels: 1, upstream: false, downstream: false } }))
  })

  it('an editor shows a hidden layer again, and can’t hide the last one', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByRole('switch', { name: /Tables/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: /Dashboards/ }))
    await waitFor(() => expect(api.putSearch).toHaveBeenCalledWith('v9', { ifDefinitionHash: 'h1', hiddenLayers: [] }))
  })

  it('its own layout brings back what it left out, and Undo leaves it out again', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Make its own layout/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success',
      expect.stringContaining('the one it left out is back'), expect.objectContaining({ label: 'Undo' }), 8000))
    notify.mock.calls.at(-1)![2]!.onClick()
    await waitFor(() => expect(api.putSearch).toHaveBeenLastCalledWith('v9', {
      ifDefinitionHash: 'h2', layout: 'inherit', hiddenLayers: ['l2'] }))
  })

  it('readers see what it shows, and nothing to change it with', async () => {
    renderIn(<SearchViewChip view={SUBSET} canEdit={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Subset of Sales overview' }))
    expect(await screen.findByText('Tables')).toBeInTheDocument()
    expect(screen.queryByText('Dashboards')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Keeps with them' })).toBeNull()
  })
})

describe('SubsetsChip', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
  })

  it('counts the subsets made from a view, and lists those you can open', async () => {
    api.listSubsets.mockResolvedValue({
      count: 3,
      items: [
        { viewId: 's1', name: 'PII', layout: 'inherit', visibility: 'workspace' },
        { viewId: 's2', name: 'Finance only', layout: 'own', visibility: 'private' },
      ],
    })
    renderIn(<SubsetsChip view={BASE} />)
    fireEvent.click(await screen.findByRole('button', { name: '3 subset views made from this view' }))
    expect(await screen.findByRole('link', { name: /PII/ })).toHaveAttribute('href', '/views/s1')
    expect(screen.getByRole('link', { name: /Finance only/ })).toHaveTextContent('own layout')
    expect(screen.getByText('And 1 you can’t open.')).toBeInTheDocument()
  })

  it('says nothing when none are made from it', async () => {
    api.listSubsets.mockResolvedValue({ count: 0, items: [] })
    const { container } = renderIn(<SubsetsChip view={BASE} />)
    await waitFor(() => expect(api.listSubsets).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
