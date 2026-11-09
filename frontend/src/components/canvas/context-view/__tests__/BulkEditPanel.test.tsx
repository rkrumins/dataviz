/**
 * BulkEditPanel — several entities read and edited as one: it says what is held
 * and what they share (Same, or Mixed with how many have it), sets a value for
 * all of them, removes a property from all, and stages it all at once. Outside a
 * draft it compares, read-only, and offers the way into one.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

import { BulkEditPanel } from '../BulkEditPanel'

const node = (id: string, properties: Record<string, unknown>): LineageNode =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id, type: 'dataset', properties } }) as unknown as LineageNode

const IDS = ['orders', 'returns', 'refunds']
const changes = () => useStagedChangesStore.getState().changes

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [
      node('orders', { owner: 'ana', sla: '1h', tier: 'gold' }),
      node('returns', { owner: 'ana', sla: '4h' }),
      node('refunds', { owner: 'ana', sla: '1h' }),
    ],
    edges: [], _nodeIndex: new Set(IDS), _edgeIndex: new Set(),
  } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useSchemaStore.setState({
    schema: { entityTypes: [{ id: 'dataset', name: 'Dataset', pluralName: 'Datasets', visual: { color: '#6366f1' } }] },
  } as never)
})

describe('BulkEditPanel', () => {
  it('says what is held, and what they share', () => {
    render(<BulkEditPanel nodeIds={IDS} canEdit onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '3 entities' })).toBeInTheDocument()
    expect(screen.getByText('Datasets')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'owner for all' })).toHaveValue('ana')
    expect(screen.getByRole('textbox', { name: 'sla for all' })).toHaveAttribute('placeholder', expect.stringMatching(/Mixed · on 3 of 3/))
    expect(screen.getAllByText('Same').length).toBeGreaterThan(0)
  })

  it('sets a value for all of them, and stages each entity\'s edit at once', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BulkEditPanel nodeIds={IDS} canEdit onClose={onClose} />)
    await user.type(screen.getByRole('textbox', { name: 'sla for all' }), '2h')
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(changes()).toHaveLength(3)
    for (const c of changes()) expect((c.after as { properties: Record<string, unknown> }).properties.sla).toBe('2h')
    expect(onClose).toHaveBeenCalled()
  })

  it('removes a property from all — staging only the entities that had it', async () => {
    const user = userEvent.setup()
    render(<BulkEditPanel nodeIds={IDS} canEdit onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Remove tier from all' }))
    expect(screen.getByText('Will be removed from all 3.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(changes().map((c) => c.targetId)).toEqual(['orders'])
  })

  it('adds a property to all of them', async () => {
    const user = userEvent.setup()
    render(<BulkEditPanel nodeIds={IDS} canEdit onClose={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: 'New property name' }), 'steward')
    await user.type(screen.getByRole('textbox', { name: 'New property value' }), 'finance{Enter}')
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(changes()).toHaveLength(3)
  })

  it('outside a draft, compares read-only and offers a draft', async () => {
    const onStartEditing = vi.fn()
    render(<BulkEditPanel nodeIds={IDS} canEdit={false} onStartEditing={onStartEditing} onClose={vi.fn()} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Stage for/ })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit in a draft' }))
    expect(onStartEditing).toHaveBeenCalled()
  })
})
