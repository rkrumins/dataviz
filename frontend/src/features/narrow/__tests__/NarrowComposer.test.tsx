/**
 * NarrowComposer — choose what the canvas shows: the starting points, how far
 * they reach, and a preview of the answer before anything is applied.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MembershipRequest, MembershipResult } from '@/types/membership'

const resolveMembers = vi.fn<(viewId: string, req: MembershipRequest) => Promise<MembershipResult>>()
vi.mock('@/providers', () => ({ useGraphProvider: () => ({ resolveMembers }) }))

import { specFor } from '../model'
import { NarrowComposer } from '../NarrowComposer'

function answer(partial: Partial<MembershipResult> = {}): MembershipResult {
  return {
    specHash: 'h',
    members: [{ urn: 'orders', via: 'seed' }, { urn: 'src', via: 'upstream', hops: 1 }, { urn: 'far', via: 'upstream', hops: 2 }],
    wholeSubtree: [],
    chains: { orders: ['wh'], src: ['wh'], far: [] },
    counts: { seeds: 1, inside: 0, upstream: 2, downstream: 0, partnerInside: 0, total: 3 },
    missingSeeds: 0,
    truncated: [],
    dataVersion: '1',
    elapsedMs: 4,
    ...partial,
  }
}

const LAYERS = [{ id: 'gold', name: 'Gold', color: '#f59e0b' }]

function renderComposer(over: Partial<Parameters<typeof NarrowComposer>[0]> = {}) {
  const props = {
    viewId: 'v1',
    draft: {
      spec: specFor({ urns: ['orders', 'customers'] }),
      seedsLabel: '2 entities',
      seedNames: { orders: 'orders', customers: 'customers' },
    },
    lineageEnabled: true,
    layers: LAYERS,
    layerOf: (urn: string) => (urn === 'wh' ? 'gold' : undefined),
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<NarrowComposer {...props} />)
  return props
}

const lastSpec = () => resolveMembers.mock.calls.at(-1)![1].spec

describe('NarrowComposer', () => {
  beforeEach(() => {
    resolveMembers.mockReset()
    resolveMembers.mockResolvedValue(answer())
  })

  it('previews what the starting points reach, and where it sits on the canvas', async () => {
    renderComposer()
    expect(screen.getByRole('list', { name: 'Starting points' })).toHaveTextContent('orderscustomers')
    await screen.findByText('across 1 layer', { exact: false })
    expect(screen.getByRole('list', { name: 'Where they sit' })).toHaveTextContent('Gold 2')
    expect(screen.getByRole('list', { name: 'Where they sit' })).toHaveTextContent('Not on the canvas yet 1')
    expect(resolveMembers).toHaveBeenCalledWith('v1', { spec: specFor({ urns: ['orders', 'customers'] }) }, expect.anything())
  })

  it('a preset asks for its reach, and the sentence says it', async () => {
    renderComposer()
    fireEvent.click(screen.getByRole('radio', { name: /Entire upstream/ }))
    await waitFor(() => expect(lastSpec().expand).toEqual({ children: 0, upstream: 'all', downstream: 0, partnerChildren: 0 }))
    expect(screen.getByText('2 entities and everything upstream')).toBeInTheDocument()
  })

  it('a starting point can be taken out', async () => {
    renderComposer()
    fireEvent.click(screen.getByRole('button', { name: 'Remove customers' }))
    await waitFor(() => expect(lastSpec().seeds.urns).toEqual(['orders']))
  })

  it('without the Lineage trace, sources and consumers are not offered — and say why', () => {
    renderComposer({ lineageEnabled: false })
    expect(screen.getByRole('radio', { name: /Entire upstream/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /One level in/ })).toBeEnabled()
    expect(screen.getAllByText('Lineage trace is turned off')).toHaveLength(2)
  })

  it('a reach that needs the Lineage trace, with it off, is not asked for — and says what to do', async () => {
    renderComposer({ lineageEnabled: false, draft: { spec: specFor({ urns: ['orders'] }, { upstream: 'all' }), seedsLabel: 'orders' } })
    expect(screen.getByText(/Choose a reach without them/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Narrow/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /One level in/ }))
    await waitFor(() => expect(resolveMembers).toHaveBeenCalledOnce())
    expect(lastSpec().expand).toEqual({ children: 1, upstream: 0, downstream: 0, partnerChildren: 0 })
  })

  it('Narrow applies the answer it previewed', async () => {
    const props = renderComposer()
    const narrow = screen.getByRole('button', { name: /^Narrow/ })
    await waitFor(() => expect(narrow).toBeEnabled())
    fireEvent.click(narrow)
    expect(props.onApply).toHaveBeenCalledWith(
      expect.objectContaining({ spec: specFor({ urns: ['orders', 'customers'] }) }), answer())
  })

  it('says every limit the answer reached, and offers to ask again when it was cut short', async () => {
    resolveMembers.mockResolvedValue(answer({ truncated: [{ reason: 'deadline', seen: 3, limit: 3 }], missingSeeds: 1 }))
    renderComposer()
    await screen.findByText(/ran out of time/)
    expect(screen.getByText(/1 chosen entity no longer exists/)).toBeInTheDocument()
    resolveMembers.mockResolvedValue(answer())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    await waitFor(() => expect(resolveMembers).toHaveBeenCalledTimes(2))
  })

  it('says what went wrong in the server’s words', async () => {
    resolveMembers.mockRejectedValue(Object.assign(
      new Error('API Error 403: {"detail":{"type":"feature_disabled","feature":"traceEnabled","message":"Lineage tracing is turned off for this deployment."}}'),
      { status: 403 },
    ))
    renderComposer()
    await screen.findByText('Lineage tracing is turned off for this deployment.')
    expect(screen.getByRole('button', { name: /^Narrow/ })).toBeDisabled()
  })

  it('a search as the starting points can be looked for in the whole data source', async () => {
    renderComposer({ draft: { spec: specFor({ query: { kind: 'text' } as never }), seedsLabel: 'the matches of your search' } })
    // Named as the starting points, and in the sentence of what it shows.
    expect(screen.getAllByText('the matches of your search')).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Whole data source' }))
    await waitFor(() => expect(lastSpec().within).toBe('dataSource'))
  })
})
