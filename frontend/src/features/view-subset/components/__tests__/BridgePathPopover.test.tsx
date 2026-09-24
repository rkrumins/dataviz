/**
 * BridgePathPopover — the steps behind a virtual hop, where the reader asked.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LineageBridgePathResult } from '@/providers/GraphDataProvider'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import { BridgePathPopover, type BridgePathTarget } from '../BridgePathPopover'

const members = [{ urn: 'A' }, { urn: 'C' }, { urn: 'D' }]
const names: Record<string, string> = { A: 'orders', C: 'revenue', D: 'margin' }

function path(over: Partial<LineageBridgePathResult> = {}): LineageBridgePathResult {
  return {
    source: 'A', target: 'C', hops: 2,
    hiddenUrns: ['B'], endpointUrns: ['A', 'C'],
    nodes: [
      { urn: 'A', entityType: 'table', displayName: 'orders', properties: {} },
      { urn: 'B', entityType: 'table', displayName: 'stg_orders', properties: {} },
      { urn: 'C', entityType: 'table', displayName: 'revenue', properties: {} },
      { urn: 'S', entityType: 'schema', displayName: 'staging', properties: {} },
    ],
    edges: [
      { id: 'e1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'TRANSFORMS' },
      { id: 'e2', sourceUrn: 'B', targetUrn: 'C', edgeType: 'TRANSFORMS' },
    ],
    ancestorChains: { B: ['S'] },
    truncated: false,
    ...over,
  }
}

const target = (links = [{ source: 'A', target: 'C', hops: 2 }]): BridgePathTarget =>
  ({ lineId: 'bridge-A|C', links, point: { x: 200, y: 200 } })

function renderPopover(props: Partial<Parameters<typeof BridgePathPopover>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const handlers = { onClose: vi.fn(), onWalkInLens: vi.fn(), onRefreshLines: vi.fn() }
  render(
    <BridgePathPopover
      target={target()}
      members={members}
      maxHops={6}
      labelOf={(urn) => names[urn]}
      {...handlers}
      {...props}
    />,
    { wrapper: wrap },
  )
  return handlers
}

afterEach(() => { holder.current = {} })

describe('BridgePathPopover', () => {
  it('shows nothing until a line is asked about', () => {
    holder.current = { getLineageBridgePath: vi.fn() }
    renderPopover({ target: null })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the hidden steps between the two, source first', async () => {
    const getLineageBridgePath = vi.fn(async (_req: unknown) => path())
    holder.current = { getLineageBridgePath }
    renderPopover()
    const dialog = await screen.findByRole('dialog', { name: /orders.*revenue/ })
    expect(within(dialog).getByText('Tracing the hidden steps…')).toBeTruthy()
    const route = await within(dialog).findByRole('list', { name: 'The route, source first' })
    const stops = within(route).getAllByRole('listitem').map(li => li.textContent)
    expect(stops[0]).toContain('orders')
    expect(stops[1]).toContain('stg_orders')
    expect(stops[1]).toContain('staging')
    expect(stops[2]).toContain('revenue')
    expect(within(dialog).getByText('via 1 hidden step')).toBeTruthy()
    expect(getLineageBridgePath.mock.calls[0][0]).toEqual({ members, source: 'A', target: 'C', maxHops: 6 })
  })

  it('walks the route in the Lens', async () => {
    holder.current = { getLineageBridgePath: vi.fn(async () => path()) }
    const { onWalkInLens } = renderPopover()
    fireEvent.click(await screen.findByRole('button', { name: /Walk it in the Lens/ }))
    expect(onWalkInLens).toHaveBeenCalledWith(['A', 'B', 'C'])
  })

  it('lets the reader pick among the links one line stands for, shortest first', async () => {
    const getLineageBridgePath = vi.fn(async (req: { target: string }) =>
      path(req.target === 'D' ? { target: 'D' } : {}))
    holder.current = { getLineageBridgePath }
    renderPopover({
      target: target([
        { source: 'A', target: 'D', hops: 4 },
        { source: 'A', target: 'C', hops: 2 },
      ]),
    })
    const group = await screen.findByRole('radiogroup')
    const options = within(group).getAllByRole('radio')
    expect(options[0].textContent).toContain('revenue')
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(options[1])
    await waitFor(() => expect(getLineageBridgePath).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'D' }), expect.anything(),
    ))
  })

  it('says so when the two no longer connect, and offers to refresh the lines', async () => {
    holder.current = { getLineageBridgePath: vi.fn(async () => path({ hops: null, hiddenUrns: [], edges: [] })) }
    const { onRefreshLines } = renderPopover()
    expect(await screen.findByText(/no longer connect within 6 steps/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Refresh lines/ }))
    expect(onRefreshLines).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Walk it in the Lens/ })).toBeNull()
  })

  it('offers a retry when the steps could not be loaded', async () => {
    const getLineageBridgePath = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce(path())
    holder.current = { getLineageBridgePath }
    renderPopover()
    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('list', { name: 'The route, source first' })).toBeTruthy()
  })

  it('flags a route it could not walk in full', async () => {
    holder.current = { getLineageBridgePath: vi.fn(async () => path({ truncated: true, truncationReason: 'max_nodes' })) }
    renderPopover()
    expect(await screen.findByText(/Some steps may be missing/)).toBeTruthy()
  })
})
