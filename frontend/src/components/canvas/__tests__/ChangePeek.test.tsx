/**
 * The change peek: a staged change told from memory at once; a saved one read from the draft only
 * once the pointer rests, then said field by field.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => ({ calls: [] as unknown[][], data: undefined as unknown }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeEntry: (...args: unknown[]) => { entry.calls.push(args); return { data: args[2] ? entry.data : undefined, isError: false } },
}))
vi.mock('@/components/panels/useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: 'ws1', graphId: 'g1', mainBranchId: 'main', branchId: 'br_1' }),
}))

import { ChangePeek } from '../ChangePeek'
import type { StagedChange } from '@/store/stagedChangesStore'

beforeEach(() => {
  vi.useFakeTimers()
  entry.calls = []
  entry.data = undefined
})

const hover = (name: string) => {
  fireEvent.mouseEnter(screen.getByText(name))
  act(() => { vi.advanceTimersByTime(100) })
}

describe('ChangePeek', () => {
  it('tells a staged change from memory, with what each field was', () => {
    const staged = {
      id: 'c1', type: 'update_entity', targetId: 'urn:t1', targetUrn: 'urn:t1', timestamp: 0, summary: 'Edit orders',
      before: { label: 'orders', properties: { owner: 'ana' } }, after: { label: 'orders', properties: { owner: 'bea' } },
    } as StagedChange
    render(<ChangePeek entityId="urn:t1" deco={{ state: 'staged', status: 'modified' }} staged={staged}>orders</ChangePeek>)
    hover('orders')
    expect(screen.getByText('Not saved yet')).toBeInTheDocument()
    expect(screen.getByText('Edited owner')).toBeInTheDocument()
    expect(screen.getByText('ana')).toHaveClass('line-through')
    expect(entry.calls.every((c) => c[2] === null)).toBe(true)
  })

  it('reads a saved change only once the pointer rests', () => {
    entry.data = { entityId: 'urn:t2', kind: 'node', status: 'modified',
      before: { displayName: 'sales', properties: { tier: 'silver' } }, after: { displayName: 'sales', properties: { tier: 'gold' } } }
    render(<ChangePeek entityId="urn:t2" deco={{ state: 'committed', status: 'modified' }}>sales</ChangePeek>)
    hover('sales')
    expect(screen.getByText('Saved in this draft')).toBeInTheDocument()
    expect(screen.getByLabelText('Reading what changed')).toBeInTheDocument()
    expect(entry.calls.every((c) => c[2] === null)).toBe(true)
    act(() => { vi.advanceTimersByTime(300) })
    expect(entry.calls.at(-1)).toEqual(['ws1', 'g1', { branchId: 'br_1' }, 'urn:t2'])
    expect(screen.getByText('Edited tier')).toBeInTheDocument()
    expect(screen.getByText('gold')).toBeInTheDocument()
  })
})
