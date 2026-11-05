/**
 * A double-click rename edits the name the row shows. In the Business view
 * that is the business label, so the rename stages it as the drawer does —
 * mirrored into the node's properties — and leaves the entity's name alone.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
}))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

const orders = {
  id: 'orders', type: 'generic', position: { x: 0, y: 0 },
  data: { label: 'orders_t2', urn: 'orders', type: 'dataset', businessLabel: 'Orders', properties: { businessLabel: 'Orders' } },
} as unknown as LineageNode

const changes = () => useStagedChangesStore.getState().changes
const after = () => changes()[0].after as LineageNode['data']

/** Open the editor on `orders` (as a double-click does) and save `value`. */
function rename(value: string, field?: 'label' | 'businessLabel') {
  const { result } = renderHook(() => useCanvasInteractions())
  act(() => result.current.startInlineEdit('orders', field === 'businessLabel' ? 'Orders' : 'orders_t2', { x: 0, y: 0 }, field))
  act(() => result.current.saveInlineEdit('orders', value))
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [orders], edges: [] } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [] } as never)
})

describe('inline rename', () => {
  it('stages the business label where the drawer does, and leaves the name alone', () => {
    rename('Customer orders', 'businessLabel')
    expect(changes()).toHaveLength(1)
    expect(changes()[0].type).toBe('update_entity')
    expect(after().businessLabel).toBe('Customer orders')
    expect(after().properties?.businessLabel).toBe('Customer orders')
    expect(after().label).toBe('orders_t2')
  })

  it('renames the entity when no field is named', () => {
    rename('orders_t3')
    expect(changes()).toHaveLength(1)
    expect(changes()[0].type).toBe('rename_entity')
    expect(after().label).toBe('orders_t3')
    expect(after().businessLabel).toBe('Orders')
  })

  it('stages nothing when the value is unchanged', () => {
    rename('Orders', 'businessLabel')
    rename('orders_t2')
    expect(changes()).toEqual([])
  })
})
