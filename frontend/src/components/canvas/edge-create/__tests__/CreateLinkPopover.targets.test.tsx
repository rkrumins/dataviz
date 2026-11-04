/**
 * "Link to…" offers only entities a link can still be drawn to. A ghost is a deletion the draft
 * has already saved, and a node marked for deletion goes on the next save — a link to either
 * would be refused by that save, or would point at nothing.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The view-schema hooks fall back to the global schema store outside a mounted view; without this
// mock ViewExecutionContext's import chain reaches `@/main`, which mounts the app at module load.
vi.mock('@/providers/ViewExecutionContext', () => ({ useViewExecutionContext: () => null }))

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useCreateLinkStore } from '../createLinkStore'
import { CreateLinkPopover } from '../CreateLinkPopover'

const node = (id: string, label: string, extra: Partial<LineageNode['data']> = {}) =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label, urn: id, type: 'table', ...extra } }) as LineageNode

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [
      node('urn:src', 'Source'),
      node('urn:live', 'Orders'),
      node('urn:ghost', 'Deleted in the draft', { isGhost: true }),
      node('urn:going', 'Marked for deletion', { isPending: 'delete' }),
      node('urn:new', 'Just created', { isPending: 'create' }),
    ],
    edges: [],
  } as never)
  useCreateLinkStore.setState({ isOpen: true, sourceUrn: 'urn:src', anchor: { x: 10, y: 10 } })
})

describe('CreateLinkPopover targets', () => {
  it('lists live and just-created entities, never a deleted one', () => {
    render(<CreateLinkPopover onCreateLink={vi.fn(() => null)} />)
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('Just created')).toBeInTheDocument()
    expect(screen.queryByText('Deleted in the draft')).toBeNull()
    expect(screen.queryByText('Marked for deletion')).toBeNull()
  })
})
