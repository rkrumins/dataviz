/**
 * The virtual-hops chip, as it sits in the canvas's status cluster: it says
 * what the stitching is doing, lists the hops (the keyboard route to each),
 * and is honest about an answer it could not finish.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasStatusChips } from '@/components/canvas/context-view/CanvasStatusChips'

import type { VirtualHopsSummary } from '../../model/virtualHops'

function summary(over: Partial<VirtualHopsSummary> = {}): VirtualHopsSummary {
  return {
    status: 'ready',
    isFetching: false,
    lines: [
      { lineId: 'bridge-C|F', sourceLabel: 'revenue', targetLabel: 'forecast', hops: 4 },
      { lineId: 'bridge-A|C', sourceLabel: 'orders', targetLabel: 'revenue', hops: 2 },
    ],
    incompleteNames: [],
    retryable: false,
    maxHops: 10,
    onOpenLine: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  }
}

function renderChips(virtualHops: VirtualHopsSummary) {
  return render(
    <CanvasStatusChips
      unresolvedEdgeCount={0}
      unassignedEntities={[]}
      aggDetailShown={0}
      aggDetailTotal={0}
      virtualHops={virtualHops}
    />,
  )
}

describe('VirtualHopsChip', () => {
  it('says the lines are being stitched', () => {
    renderChips(summary({ status: 'loading', lines: [] }))
    expect(screen.getByRole('status').textContent).toContain('Stitching lineage…')
  })

  it('counts the hops and lists them, shortest first, each one a way into its steps', () => {
    const s = summary()
    renderChips(s)
    fireEvent.click(screen.getByRole('button', { name: '2 virtual hops' }))
    const list = screen.getByRole('list', { name: 'Virtual hops on this board' })
    const rows = within(list).getAllByRole('button')
    expect(rows.map(r => r.textContent)).toEqual(['ordersrevenuevia 1', 'revenueforecastvia 3'])
    fireEvent.click(rows[1])
    expect(s.onOpenLine).toHaveBeenCalledWith('bridge-C|F', expect.objectContaining({ x: expect.any(Number) }))
  })

  it('names who may be missing links, and offers a retry only when one could help', () => {
    const s = summary({ status: 'partial', incompleteNames: ['orders'], retryable: true })
    renderChips(s)
    fireEvent.click(screen.getByRole('button', { name: '2 virtual hops, may be incomplete' }))
    const note = screen.getAllByRole('status').find(n => n.textContent?.includes('missing'))!
    expect(note.textContent).toContain('Some links may be missing for orders')
    fireEvent.click(within(note).getByRole('button', { name: /Try again/ }))
    expect(s.onRetry).toHaveBeenCalled()
  })

  it('does not offer a retry for lineage too large to walk', () => {
    renderChips(summary({ status: 'partial', incompleteNames: ['orders'], retryable: false }))
    fireEvent.click(screen.getByRole('button', { name: /may be incomplete/ }))
    expect(screen.getByText(/too large to walk in full/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
  })

  it('reports a failure with a retry', () => {
    const s = summary({ status: 'error', lines: [] })
    renderChips(s)
    expect(screen.getByRole('alert').textContent).toContain("Couldn't stitch lineage")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(s.onRetry).toHaveBeenCalled()
  })

  it('says a view too large to stitch has its hops paused', () => {
    renderChips(summary({ status: 'oversized', lines: [] }))
    expect(screen.getByText('Virtual hops paused')).toBeTruthy()
  })

  it('stays silent with nothing to draw or no walk on offer', () => {
    const quiet = renderChips(summary({ lines: [] }))
    expect(quiet.container.textContent).toBe('')
    quiet.unmount()
    const off = renderChips(summary({ status: 'disabled', lines: [] }))
    expect(off.container.textContent).toBe('')
  })
})
