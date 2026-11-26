/**
 * ConnectionCopiesResolver — a connection the source holds more than once is shown with its
 * versions side by side and what it will be copied as; each choice is saved as it is made.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapReviewConnection } from '@/services/versioningApiService'

// jsdom has no layout, so @tanstack/react-virtual would render no rows: give it a viewport and a
// ResizeObserver so the virtualized cards mount (as ConflictResolver's tests do).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const saveMutate = vi.fn()
let items: BootstrapReviewConnection[] = []
vi.mock('../../hooks/useVersioning', () => ({
  useBootstrapReview: () => ({ data: { pages: [{ items, next: null }] }, isLoading: false, hasNextPage: false }),
  useSaveBootstrapReviewChoice: () => ({ mutate: saveMutate, isPending: false, isError: false }),
}))

import { ConnectionCopiesResolver } from '../ConnectionCopiesResolver'

const CALLS: BootstrapReviewConnection = {
  entityId: 'urn:a|CALLS|urn:b', edgeType: 'CALLS', source: 'urn:a', target: 'urn:b',
  versions: [
    { seq: 1, count: 2, ids: ['urn:a|CALLS|urn:b'], confidence: null, properties: { at: 'mon', who: 'ana' } },
    { seq: 2, count: 1, ids: ['edge:urn:a|CALLS|urn:b'], confidence: null, properties: { at: 'tue' } },
  ],
  clashing: ['at', 'who'],
  choice: null,
}

const open = (connection: BootstrapReviewConnection, policy = { rule: 'merge' as const, excludeProperties: [] }) => {
  items = [connection]
  return render(<ConnectionCopiesResolver wsId="ws1" dataSourceId="ds1" policy={policy} onClose={vi.fn()} />)
}

beforeEach(() => { vi.clearAllMocks(); saveMutate.mockReset() })

describe('a connection held more than once', () => {
  it('shows each version side by side, what differs, and what it is copied as', () => {
    open(CALLS)
    const card = screen.getByRole('region', { name: 'Connection urn:a|CALLS|urn:b' })
    expect(within(card).getByText('3 copies, 2 versions')).toBeInTheDocument()
    expect(within(card).getAllByText('differs')).toHaveLength(2)
    expect(within(card).getByText(/Version 1/)).toBeInTheDocument()
    const at = within(card).getByText('at').closest('tr')!
    expect(within(at).getAllByText('mon')).toHaveLength(2)     // version 1, and the result
    expect(screen.getByText(/Nothing is lost while you decide/)).toBeInTheDocument()
  })

  it('saves a version kept, or a merge, for this connection only', () => {
    open(CALLS)
    fireEvent.click(screen.getByRole('radio', { name: 'Keep version 2' }))
    expect(saveMutate).toHaveBeenCalledWith({ entityId: 'urn:a|CALLS|urn:b',
      choice: { rule: 'keep', keep: 2, excludeProperties: [] } }, expect.anything())
    expect(screen.getByRole('status')).toHaveTextContent('Saving')
    expect(screen.getByRole('radio', { name: 'Merge them' })).toBeDisabled()   // one save at a time
  })

  it('saves a merge once the last save landed', () => {
    saveMutate.mockImplementation((_v, { onSuccess }) => onSuccess())
    open(CALLS)
    fireEvent.click(screen.getByRole('radio', { name: 'Merge them' }))
    expect(saveMutate).toHaveBeenLastCalledWith({ entityId: 'urn:a|CALLS|urn:b',
      choice: { rule: 'merge', excludeCopies: [], values: {}, excludeProperties: [] } }, expect.anything())
  })

  it('picks the value where versions disagree, and leaves a property out', () => {
    open({ ...CALLS, choice: { rule: 'merge', excludeCopies: [], values: {}, excludeProperties: [] } })
    fireEvent.click(screen.getByRole('radio', { name: "Use version 2's at" }))
    expect(saveMutate).toHaveBeenCalledWith({ entityId: 'urn:a|CALLS|urn:b',
      choice: { rule: 'merge', excludeCopies: [], values: { at: 2 }, excludeProperties: [] } }, expect.anything())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leave who out' }))
    expect(saveMutate).toHaveBeenLastCalledWith({ entityId: 'urn:a|CALLS|urn:b',
      choice: { rule: 'merge', excludeCopies: [], values: {}, excludeProperties: ['who'] } }, expect.anything())
  })

  it('goes back to the rule for all', () => {
    open({ ...CALLS, choice: { rule: 'keep', keep: 2 } })
    fireEvent.click(screen.getByRole('radio', { name: /The rule for all/ }))
    expect(saveMutate).toHaveBeenCalledWith({ entityId: 'urn:a|CALLS|urn:b', choice: null }, expect.anything())
  })
})

describe('saving a choice', () => {
  it('says on the card when it landed, and when it did not', () => {
    saveMutate.mockImplementationOnce((_v, { onSuccess }) => onSuccess())
    open(CALLS)
    fireEvent.click(screen.getByRole('radio', { name: 'Keep version 1' }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    saveMutate.mockImplementationOnce((_v, { onError }) => onError(new Error('refused')))
    fireEvent.click(screen.getByRole('radio', { name: 'Merge them' }))
    expect(screen.getByRole('status')).toHaveTextContent('Not saved')
  })
})
