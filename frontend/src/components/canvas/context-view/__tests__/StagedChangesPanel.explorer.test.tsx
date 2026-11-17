/**
 * Review & Save at volume: one row per thing changed, the selected one beside the list, moved
 * through with the keyboard or Prev / Next ("2 of 3"), narrowed by the filter bar — and the changes
 * shown discarded in one go.
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
const detail = () => screen.getByRole('region', { name: 'The selected change' })

beforeEach(() => {
  useStagedChangesStore.setState({
    changes: [rename('a', 'orders', 'Orders'), rename('b', 'sales', 'Sales'), create('c', 'Refunds')],
    past: [], redoStack: [], isReviewPanelOpen: true, applyStatus: 'idle', lastApplyResult: null,
  } as never)
})

describe('Review & Save — the change explorer', () => {
  it('lists each change and shows the first beside the list', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(within(detail()).getByText('1')).toBeInTheDocument()
    expect(within(detail()).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Renamed orders to Orders')).toBeInTheDocument()
  })

  it('moves through the changes with J/K and Prev / Next', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    const list = screen.getByRole('listbox', { name: 'Staged changes' })
    fireEvent.keyDown(list, { key: 'j' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(within(detail()).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Renamed sales to Sales')).toBeInTheDocument()
    fireEvent.click(within(detail()).getByRole('button', { name: 'Next change' }))
    expect(within(detail()).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Added Refunds at the top level')).toBeInTheDocument()
    expect(within(detail()).getByRole('button', { name: 'Next change' })).toBeDisabled()
    fireEvent.keyDown(list, { key: 'Home' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('narrows by status and discards just the changes shown', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Modified/ }))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByText('shown of 3', { exact: false })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard the 2 shown' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(state().changes.map((c) => c.id)).toEqual(['c'])
    act(() => { state().redo() })
    expect(state().changes.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
    confirmSpy.mockRestore()
  })

  it('discarding the selected change selects the next', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Staged changes' }), { key: 'Delete' })
    expect(state().changes.map((c) => c.id)).toEqual(['b', 'c'])
    expect(within(detail()).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Renamed sales to Sales')).toBeInTheDocument()
  })

  it('steps through the changes shown on the canvas, from the selected one', () => {
    useChangeNavigatorStore.setState({ canReveal: true, active: false })
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Staged changes' }), { key: 'j' })
    fireEvent.click(within(detail()).getByRole('button', { name: /Step through/ }))
    const nav = useChangeNavigatorStore.getState()
    expect(state().isReviewPanelOpen).toBe(false)
    expect(nav.active).toBe(true)
    expect(nav.stops.map((s) => s.id)).toEqual(['urn:a', 'urn:b', 'urn:c'])
    expect(nav.index).toBe(1)
    useChangeNavigatorStore.setState({ canReveal: false, active: false })
  })

  it('lists the changes under a heading per type, and moves between rows only', () => {
    useStagedChangesStore.setState({
      changes: [rename('a', 'orders', 'Orders'), { ...create('c', 'Refunds'), after: { displayName: 'Refunds', entityType: 'Table' } },
        { ...rename('b', 'sales', 'Sales'), type: 'rename_entity' }],
    } as never)
    render(<StagedChangesPanel onConfirm={() => {}} />)
    const list = screen.getByRole('listbox', { name: 'Staged changes' })
    expect(within(list).getByText('Table')).toBeInTheDocument()
    expect(within(list).getByText('Untyped')).toBeInTheDocument()
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options.map((o) => o.getAttribute('aria-posinset'))).toEqual(['1', '2', '3'])
    expect(options.every((o) => o.getAttribute('aria-setsize') === '3')).toBe(true)
    fireEvent.keyDown(list, { key: 'j' })
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'End' })
    expect(within(list).getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
  })
})
