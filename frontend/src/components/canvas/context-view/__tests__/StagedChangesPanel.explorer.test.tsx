/**
 * Review & Save at volume: one row per thing changed, each a summary first and opened to what it
 * changes, moved through with the keyboard ("Change 2 of 3"), narrowed by the filter bar — and the
 * changes shown discarded in one go.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no layout: lay every row of the virtualized list out.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 52, size: 52,
    })),
    getTotalSize: () => opts.count * 52,
    scrollToIndex: () => undefined,
    measureElement: () => undefined,
  }),
}))

import { StagedChangesPanel } from '../StagedChangesPanel'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useChangeNavigatorStore } from '@/store/changeNavigatorStore'

const rename = (id: string, from: string, to: string): StagedChange => ({
  id, type: 'rename_entity', targetId: `urn:${id}`, targetUrn: `urn:${id}`, timestamp: 0,
  summary: `rename ${from}`, before: { label: from }, after: { label: to },
})
const create = (id: string, name: string): StagedChange => ({
  id, type: 'create_entity', targetId: `urn:${id}`, targetUrn: `urn:${id}`, timestamp: 0,
  summary: `create ${name}`, after: { displayName: name },
})

const state = () => useStagedChangesStore.getState()
const list = () => screen.getByRole('list', { name: 'Staged changes' })
const rowButtons = () => within(list()).getAllByRole('button', { expanded: false }).concat(
  within(list()).queryAllByRole('button', { expanded: true })).filter((b) => b.id.startsWith('review-row-'))
const rowButton = (name: RegExp) => within(list()).getAllByRole('button').find((b) => b.id.startsWith('review-row-') && name.test(b.textContent ?? ''))!
const currentRow = () => within(list()).getAllByRole('button').find((b) => b.id.startsWith('review-row-') && b.tabIndex === 0)

beforeEach(() => {
  useStagedChangesStore.setState({
    changes: [rename('a', 'orders', 'Orders'), rename('b', 'sales', 'Sales'), create('c', 'Refunds')],
    past: [], redoStack: [], isReviewPanelOpen: true, applyStatus: 'idle', lastApplyResult: null,
  } as never)
})

describe('Review & Save — the change explorer', () => {
  it('lists each change as a summary, none opened yet', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list()).getAllByText('Edited Name')).toHaveLength(2)
    expect(within(list()).getAllByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'Added Refunds at the top level').length).toBeGreaterThan(0)
    expect(within(list()).queryAllByRole('region')).toHaveLength(0)
    expect(screen.getByText((_, el) => el?.textContent === 'Change 1 of 3')).toBeInTheDocument()
  })

  it('opens a change to what it changes, and moves through them by keyboard', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.click(rowButton(/^orders|^Orders/))
    expect(rowButton(/Orders/)).toHaveAttribute('aria-expanded', 'true')
    expect(within(list()).getByRole('region')).toHaveTextContent(/orders.*Orders/)
    fireEvent.keyDown(rowButton(/Orders/), { key: 'j' })
    expect(currentRow()).toBe(rowButton(/Sales/))
    expect(screen.getByText((_, el) => el?.textContent === 'Change 2 of 3')).toBeInTheDocument()
    fireEvent.keyDown(rowButton(/Sales/), { key: 'ArrowRight' })
    expect(rowButton(/Sales/)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(rowButton(/Sales/), { key: 'ArrowLeft', shiftKey: true })
    expect(within(list()).queryAllByRole('region')).toHaveLength(0)
    fireEvent.keyDown(rowButton(/Sales/), { key: 'Home' })
    expect(currentRow()).toBe(rowButton(/Orders/))
  })

  it('opens every change shown at once', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(within(list()).getAllByRole('region')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(within(list()).queryAllByRole('region')).toHaveLength(0)
  })

  it('narrows by status and discards just the changes shown', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Modified/ }))
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('shown of 3', { exact: false })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard the 2 shown' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(state().changes.map((c) => c.id)).toEqual(['c'])
    act(() => { state().redo() })
    expect(state().changes.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
    confirmSpy.mockRestore()
  })

  it('discarding the current change moves on to the next', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.keyDown(rowButton(/Orders/), { key: 'Delete' })
    expect(state().changes.map((c) => c.id)).toEqual(['b', 'c'])
    expect(currentRow()).toBe(rowButton(/Sales/))
  })

  it('steps through the changes shown on the canvas, from the current one', () => {
    useChangeNavigatorStore.setState({ canReveal: true, active: false })
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.keyDown(rowButton(/Orders/), { key: 'j' })
    fireEvent.click(screen.getByRole('button', { name: /Step through/ }))
    const nav = useChangeNavigatorStore.getState()
    expect(state().isReviewPanelOpen).toBe(false)
    expect(nav.active).toBe(true)
    expect([0, 1, 2].map((i) => nav.source?.at(i)?.id)).toEqual(['urn:a', 'urn:b', 'urn:c'])
    expect(nav.index).toBe(1)
    useChangeNavigatorStore.setState({ canReveal: false, active: false })
  })

  it('lists the changes under a heading per type, each saying where it stands', () => {
    useStagedChangesStore.setState({
      changes: [rename('a', 'orders', 'Orders'), { ...create('c', 'Refunds'), after: { displayName: 'Refunds', entityType: 'Table' } },
        { ...rename('b', 'sales', 'Sales'), type: 'rename_entity' }],
    } as never)
    render(<StagedChangesPanel onConfirm={() => {}} />)
    expect(within(list()).getByText('Table')).toBeInTheDocument()
    expect(within(list()).getByText('Untyped')).toBeInTheDocument()
    const items = within(list()).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items.map((o) => o.getAttribute('aria-posinset'))).toEqual(['1', '2', '3'])
    expect(items.every((o) => o.getAttribute('aria-setsize') === '3')).toBe(true)
    expect(rowButtons()).toHaveLength(3)
  })

  it('opens a single change by itself', () => {
    useStagedChangesStore.setState({ changes: [rename('a', 'orders', 'Orders')] } as never)
    render(<StagedChangesPanel onConfirm={() => {}} />)
    expect(rowButton(/Orders/)).toHaveAttribute('aria-expanded', 'true')
  })
})
