/**
 * Review & Save top-down: the staged changes under their containers as the canvas places them,
 * each container saying how many changes are inside; filtered, each change says where it sits, and
 * "In hierarchy" clears the filter and opens the way down to it. Hierarchy, List and Map are one
 * choice, remembered with every change list's.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const node = (id: string, label: string, parentId?: string) => ({ id, position: { x: 0, y: 0 }, data: { urn: id, label, type: 'Table', parentId } })
const edit = (id: string, urn: string, from: string, to: string): StagedChange => ({
  id, type: 'rename_entity', targetId: urn, targetUrn: urn, timestamp: 0, summary: `rename ${from}`,
  before: { label: from }, after: { label: to },
})

beforeEach(() => {
  usePreferencesStore.setState({ changeListLayout: 'tree' })
  useCanvasStore.setState({ nodes: [node('urn:db', 'warehouse'), node('urn:sales', 'sales', 'urn:db'), node('urn:orders', 'orders', 'urn:sales'), node('urn:refunds', 'refunds', 'urn:sales')] } as never)
  useStagedChangesStore.setState({
    changes: [edit('a', 'urn:orders', 'orders', 'Orders'), edit('b', 'urn:refunds', 'refunds', 'Refunds')],
    past: [], redoStack: [], isReviewPanelOpen: true, applyStatus: 'idle', lastApplyResult: null,
  } as never)
})

const tree = () => screen.getByRole('list', { name: 'Staged changes, top-down' })
const rowNamed = (name: RegExp) => within(tree()).getAllByRole('button').find((b) => b.id.startsWith('change-tree-') && name.test(b.textContent ?? ''))!

describe('Review & Save — top-down', () => {
  it('lays the changes out under their containers, each saying how many are inside — a small review all open', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    expect(screen.getByRole('radio', { name: /Hierarchy/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(tree()).getAllByText('2 inside')).toHaveLength(2)
    expect(within(tree()).getAllByRole('listitem').map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '3', '3'])
    // ← closes a container (and it stays closed); → opens it again.
    fireEvent.keyDown(rowNamed(/warehouse/), { key: 'j' })
    fireEvent.keyDown(rowNamed(/sales/), { key: 'ArrowLeft' })
    expect(within(tree()).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.keyDown(rowNamed(/sales/), { key: 'ArrowRight' })
    expect(rowNamed(/^orders/)).toBeInTheDocument()
    // A change in the tree is Review & Save's own row: Delete discards it.
    fireEvent.keyDown(rowNamed(/sales/), { key: 'j' })
    fireEvent.keyDown(rowNamed(/^orders/), { key: 'Delete' })
    expect(useStagedChangesStore.getState().changes.map((c) => c.id)).toEqual(['b'])
  })

  it('filtered, says where each change sits, and opens the way down to one', async () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'Refunds' } })
    const list = await screen.findByRole('list', { name: 'Staged changes' })
    expect(within(list).getByText('warehouse › sales')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'Show refunds in the hierarchy' }))
    await waitFor(() => expect(rowNamed(/^refunds/)).toHaveAttribute('tabindex', '0'))
    expect(rowNamed(/^refunds/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('Hierarchy, List and Map are one choice, remembered', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: /^List/ }))
    expect(usePreferencesStore.getState().changeListLayout).toBe('list')
    expect(screen.getByRole('list', { name: 'Staged changes' })).toBeInTheDocument()
  })
})
