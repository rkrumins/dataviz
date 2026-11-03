/**
 * LiveViewChip — a view made from a query says so in its header, says how
 * keeping it up to date is going, and lets an editor act on it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MembershipStatus, RefreshResult } from '@/types/membership'

const api = {
  getMembershipStatus: vi.fn<(viewId: string) => Promise<MembershipStatus>>(),
  refreshMembership: vi.fn<(viewId: string, confirm?: boolean) => Promise<RefreshResult>>(),
  putMembership: vi.fn(),
  memberOps: vi.fn(),
}
vi.mock('@/services/liveViewsApi', () => ({
  MEMBERSHIP_QUERY_KEY: 'view-membership',
  getMembershipStatus: (id: string) => api.getMembershipStatus(id),
  refreshMembership: (id: string, c?: boolean) => api.refreshMembership(id, c),
  putMembership: (...a: unknown[]) => api.putMembership(...a),
  memberOps: (...a: unknown[]) => api.memberOps(...a),
}))
vi.mock('@/services/viewApiService', () => ({ getView: vi.fn().mockResolvedValue(null), viewToViewConfig: (v: unknown) => v }))
vi.mock('@/store/features', () => ({ useFeature: () => true }))

import { LiveViewChip } from '../LiveViewChip'

function status(over: Partial<MembershipStatus> = {}): MembershipStatus {
  return {
    mode: 'live', status: 'ok', revision: 2, definitionHash: 'h1', keys: 1321, limit: 5000,
    definition: {
      v: 1, mode: 'live', sources: [{ spec: { v: 1, seeds: { urns: ['urn:a', 'urn:b'] }, within: 'view', expand: { children: 1, upstream: 0, downstream: 0, partnerChildren: 0 } } }],
      layout: { kind: 'source' }, exclude: [], overrides: {}, provenance: { origin: 'narrow' },
    },
    counts: { members: 1234, containers: 87 }, truncated: [],
    readIn: [{ viewId: 'v1', name: 'Sales overview', available: true }],
    alwaysIncluded: ['urn:li:dataset:kept'], excluded: [], lastAppliedAt: '2026-11-03T10:00:00Z',
    lastDiff: { added: 3, removed: 1, moved: 0 }, ...over,
  }
}

const VIEW = { id: 'v9', name: 'Orders', config: { membership: { v: 1 } } } as never

function renderChip(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><LiveViewChip view={VIEW} canEdit={canEdit} /></QueryClientProvider>)
}

describe('LiveViewChip', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    api.getMembershipStatus.mockResolvedValue(status())
  })

  it('names the view auto-updating with its count, and opens what it is made of', async () => {
    renderChip()
    const chip = await screen.findByRole('button', { name: /Auto-updating · 1,234/ })
    fireEvent.click(chip)
    expect(await screen.findByText(/Made from 2 chosen entities and one level inside them/)).toBeInTheDocument()
    expect(screen.getByText('Sales overview')).toBeInTheDocument()
    expect(screen.getByText('3 new, 1 left')).toBeInTheDocument()
    expect(screen.getByText('kept')).toBeInTheDocument()
  })

  it('renders nothing for a view not made from a query', () => {
    const client = new QueryClient()
    const { container } = render(
      <QueryClientProvider client={client}><LiveViewChip view={{ id: 'v', config: {} } as never} canEdit /></QueryClientProvider>,
    )
    expect(container).toBeEmptyDOMElement()
    expect(api.getMembershipStatus).not.toHaveBeenCalled()
  })

  it('a refresh that would remove much of the view waits, and Apply confirms it', async () => {
    api.refreshMembership.mockResolvedValueOnce({
      outcome: 'held', detail: { removed: 812, of: 1020 }, membership: status({ status: 'held', detail: { removed: 812, of: 1020 } }),
    })
    api.refreshMembership.mockResolvedValueOnce({ outcome: 'applied', detail: {}, diff: { added: 0, removed: 812, moved: 0 }, membership: status() })
    renderChip()
    fireEvent.click(await screen.findByRole('button', { name: /Auto-updating/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Refresh now/ }))
    expect(await screen.findByText('An update would remove 812 of 1,020.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    await waitFor(() => expect(api.refreshMembership).toHaveBeenLastCalledWith('v9', true))
  })

  it('readers see how it is kept, and nothing to change it with', async () => {
    renderChip(false)
    fireEvent.click(await screen.findByRole('button', { name: /Auto-updating/ }))
    expect(await screen.findByText(/Only someone who can edit this view/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Refresh now/ })).toBeNull()
  })

  it('a snapshot reads as one, and offers to resume', async () => {
    api.getMembershipStatus.mockResolvedValue(status({ mode: 'snapshot', status: 'frozen' }))
    renderChip()
    fireEvent.click(await screen.findByRole('button', { name: /Snapshot/ }))
    expect(await screen.findByRole('button', { name: /Resume updates/ })).toBeInTheDocument()
  })
})
