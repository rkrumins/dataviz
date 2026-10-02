/**
 * BulkLinkCard — the card a selection drag opens at its drop: it says how many
 * links it adds, adds exactly those, flips direction on Swap, and hands off to
 * the full panel without losing what it holds. BulkLinkMarks marks the other
 * side on the canvas.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'
import { BulkLinkCard } from '../BulkLinkCard'
import { BulkLinkMarks } from '../BulkLinkMarks'
import { useBulkLinkStore } from '../bulkLinkStore'

const node = (id: string, type: string) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type } }) as unknown as LineageNode
const rel = (id: string, name: string, sourceTypes: string[], targetTypes: string[]) => ({
  id, name, sourceTypes, targetTypes, isLineage: true, bidirectional: false, showLabel: false,
  visual: { strokeColor: '#000', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow' },
})

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [node('t1', 'table'), node('t2', 'table'), node('t3', 'table'), node('r1', 'report')],
    edges: [],
  } as never)
  useSchemaStore.setState({
    schema: {
      entityTypes: [{ id: 'table', name: 'Table' }, { id: 'report', name: 'Report' }],
      relationshipTypes: [rel('FLOWS_TO', 'Flows To', ['table'], ['table', 'report'])],
      containmentEdgeTypes: ['CONTAINS'],
    } as unknown as WorkspaceSchema,
  })
  useBulkLinkStore.getState().openCard({ direction: 'selection-feeds', picked: ['r1'], anchor: { x: 100, y: 100 } })
})

function renderCard() {
  const onCreate = vi.fn(() => ({ staged: 0, rejected: [] }))
  const onClose = vi.fn()
  render(<BulkLinkCard selection={['t1', 't2']} labelFor={(id) => id} onCreate={onCreate} onClose={onClose} />)
  return { onCreate, onClose }
}

describe('BulkLinkCard', () => {
  it('two selected tables dropped on a report: adds exactly those two links', () => {
    const { onCreate, onClose } = renderCard()
    expect(screen.getByRole('heading', { name: 'Add 2 links' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }))
    expect(onCreate).toHaveBeenCalledWith([{ source: 't1', target: 'r1' }, { source: 't2', target: 'r1' }], 'FLOWS_TO')
    expect(onClose).toHaveBeenCalled()
  })

  it('Enter adds, Escape closes', () => {
    const { onCreate, onClose } = renderCard()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Swap turns it round, and the ontology refuses a report feeding tables — with the reason', () => {
    const { onCreate } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }))
    expect(screen.getByRole('heading', { name: 'Nothing to add yet' })).toBeInTheDocument()
    expect(screen.getByText(/can't be the source/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('"More options…" opens the full panel holding the same links', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }))
    fireEvent.click(screen.getByRole('button', { name: 'More options…' }))
    expect(useBulkLinkStore.getState()).toMatchObject({ surface: 'panel', direction: 'feeds-selection', picked: ['r1'] })
  })

  it('"Add targets" arms picking on the canvas', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Add targets' }))
    expect(useBulkLinkStore.getState().pickingOnCanvas).toBe(true)
  })
})

describe('BulkLinkMarks', () => {
  it('rings the picked cards with their role, and the hovered card by its verdict', () => {
    const { container } = render(
      <BulkLinkMarks picked={['r1', 'a:b']} pickedRole="Target" hover={{ id: 't3', level: 'none' }} />,
    )
    const css = container.querySelector('style')!.textContent!
    expect(css).toContain('#layer-node-r1')
    expect(css).toContain('content:"Target"')
    // Ids with CSS metacharacters are escaped, or the whole rule is dropped.
    expect(css).toContain('#layer-node-a\\:b')
    expect(css).toMatch(/#layer-node-t3\{outline:2px solid #ef4444/)
  })

  it('renders nothing when there is nothing to mark', () => {
    const { container } = render(<BulkLinkMarks picked={[]} pickedRole="Target" />)
    expect(container.querySelector('style')).toBeNull()
  })
})
