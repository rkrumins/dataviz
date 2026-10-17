/**
 * The palette reaches every filter value from the keyboard. Enter must apply and
 * close; ⌘/Ctrl+Enter must apply and stay open, for picking several in a row; and
 * an option already on must show it and turn off when picked again.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', () => ({ getViewFacets: vi.fn() }))

import { getViewFacets, type ViewFacetsResponse } from '@/services/viewApiService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { EMPTY_FILTERS, type ViewFilterState } from '../model'
import { FilterPalette, type PaletteSavedFilter } from '../components/FilterPalette'

const FACETS: ViewFacetsResponse = {
  tags: [{ value: 'pii', count: 5 }, { value: 'finance', count: 2 }],
  viewTypes: [], creators: [],
  contributors: [{
    userId: 'u_ada', displayName: 'Ada Lovelace', email: 'ada@example.com', avatarId: null,
    count: 4, createdCount: 4, editedCount: 0, publishedCount: 0,
  }],
  sourceKinds: { versioned: 6, external: 2 },
}

function renderPalette(state: ViewFilterState = EMPTY_FILTERS, saved?: PaletteSavedFilter[]) {
  const onChange = vi.fn<(update: (prev: ViewFilterState) => ViewFilterState) => void>()
  const onClose = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FilterPalette
        state={state}
        onChange={onChange}
        ctx={{ currentUserId: 'u_me', today: '2026-10-12' }}
        currentUser={{ id: 'u_me', name: 'Me Myself', email: 'me@example.com' }}
        saved={saved}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  const input = screen.getByPlaceholderText(/Filter by a person/)
  /** The state the last change would leave. */
  const applied = () => onChange.mock.lastCall![0](state)
  return { input, onChange, onClose, applied }
}

beforeEach(() => {
  vi.mocked(getViewFacets).mockReset()
  vi.mocked(getViewFacets).mockResolvedValue(FACETS)
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } })
})

describe('FilterPalette', () => {
  // cmdk's own ranking picked a date preset here, from a group listed before Tags.
  it('applies the best match and closes on Enter', async () => {
    const { input, onClose, applied } = renderPalette()
    await screen.findByText('pii')
    fireEvent.change(input, { target: { value: 'tag pii' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(applied()).toMatchObject({ tags: ['pii'] })
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open on ⌘/Ctrl+Enter', async () => {
    const { input, onClose, applied } = renderPalette()
    await screen.findByText('Versioned')
    fireEvent.change(input, { target: { value: 'versioned' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(applied()).toMatchObject({ sourceKind: 'versioned' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows live counts and marks what is on, and picking it again turns it off', async () => {
    const { input, applied } = renderPalette({ ...EMPTY_FILTERS, tags: ['pii'] })
    await waitFor(() => expect(screen.getByText('pii').closest('[cmdk-item]')!.textContent).toMatch(/5/))
    expect(screen.getByText('pii').closest('[cmdk-item]')!.querySelector('[aria-label="On"]')).not.toBeNull()
    fireEvent.change(input, { target: { value: 'tag pii' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(applied()).toMatchObject({ tags: [] })
  })

  it('finds a saved filter by its name', async () => {
    const apply = vi.fn()
    const { input, onClose } = renderPalette(EMPTY_FILTERS, [{ id: 's1', name: 'Finance weekly', active: false, apply }])
    await screen.findByText('finance')
    fireEvent.change(input, { target: { value: 'finance weekly' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(apply).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { input, onClose } = renderPalette()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
