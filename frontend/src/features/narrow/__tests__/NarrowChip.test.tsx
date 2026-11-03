/**
 * NarrowChip — a narrowed canvas says so, for as long as it is narrowed, with
 * how to change it, share it, or put it away.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MembershipResult } from '@/types/membership'

import { specFor, visibilityOf } from '../model'
import { NarrowChip } from '../NarrowChip'
import type { AppliedNarrow } from '../narrowStore'

function applied(partial: Partial<MembershipResult> = {}): AppliedNarrow {
  const result: MembershipResult = {
    specHash: 'h', members: [], wholeSubtree: [], chains: {},
    counts: { seeds: 1, inside: null, upstream: 40, downstream: 0, partnerInside: 0, total: 412 },
    missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0, ...partial,
  }
  return {
    spec: specFor({ urns: ['orders'] }, { children: 'all', upstream: 'all' }),
    seedsLabel: 'orders',
    result,
    visibility: visibilityOf(result),
  }
}

describe('NarrowChip', () => {
  it('says how much is shown, and what', () => {
    render(<NarrowChip applied={applied()} onEdit={vi.fn()} onClear={vi.fn()} />)
    const chip = screen.getByRole('status', { name: 'The canvas is narrowed' })
    expect(chip).toHaveTextContent('Narrowed to 412 entities')
    expect(chip).toHaveTextContent('orders, everything inside it and everything upstream')
  })

  it('changes, or puts away, the narrowing', () => {
    const onEdit = vi.fn()
    const onClear = vi.fn()
    render(<NarrowChip applied={applied()} onEdit={onEdit} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.click(screen.getByRole('button', { name: /Show everything/ }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('copies a link to it — or says why it cannot', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { rerender } = render(<NarrowChip applied={applied()} onEdit={vi.fn()} onClear={vi.fn()} link={() => 'https://x/v?narrow=t'} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })) })
    expect(writeText).toHaveBeenCalledWith('https://x/v?narrow=t')
    expect(screen.getByRole('button', { name: 'Copy link' })).toHaveTextContent('Copied')

    rerender(<NarrowChip applied={applied()} onEdit={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled()
  })

  it('warns when not everything is shown, and offers to ask again only when that may help', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<NarrowChip
      applied={applied({ truncated: [{ reason: 'member_cap', seen: 60000, limit: 50000 }] })}
      onEdit={vi.fn()} onClear={vi.fn()} onRetry={onRetry} />)
    expect(screen.getByLabelText('Not everything it reaches is shown')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()

    rerender(<NarrowChip
      applied={applied({ truncated: [{ reason: 'incomplete', seen: 3, limit: 3 }] })}
      onEdit={vi.fn()} onClear={vi.fn()} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('NarrowChip — Save as view', () => {
  it('offers to keep the narrowing as a view only when it can be', () => {
    const onSaveAsView = vi.fn()
    const { rerender } = render(<NarrowChip applied={applied()} onEdit={vi.fn()} onClear={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Save as view/ })).toBeNull()
    rerender(<NarrowChip applied={applied()} onEdit={vi.fn()} onClear={vi.fn()} onSaveAsView={onSaveAsView} />)
    fireEvent.click(screen.getByRole('button', { name: /Save as view/ }))
    expect(onSaveAsView).toHaveBeenCalledOnce()
  })
})
