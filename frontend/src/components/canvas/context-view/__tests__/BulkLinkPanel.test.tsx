/**
 * BulkLinkPanel — the selection is one side, the reader picks the other and
 * says which way the data flows; every pair is previewed with its verdict,
 * and only the pairs the ontology allows are handed to be staged.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'
import { BulkLinkPanel } from '../BulkLinkPanel'

const node = (id: string, type: string) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type } }) as unknown as LineageNode
const rel = (id: string, name: string, sourceTypes: string[], targetTypes: string[]) => ({
  id, name, sourceTypes, targetTypes, isLineage: true, bidirectional: false, showLabel: false,
  visual: { strokeColor: '#000', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow' },
})

const tables = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)

function seed(existing: Array<{ source: string; target: string; edgeType: string }> = [], tableCount = 6) {
  useCanvasStore.setState({
    nodes: [...tables(tableCount).map((id) => node(id, 'table')), node('r1', 'report'), node('r2', 'report'), node('logical:g', 'group')],
    edges: existing.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, type: 'lineage', data: { edgeType: e.edgeType } })),
  } as never)
  useSchemaStore.setState({
    schema: {
      entityTypes: [
        { id: 'table', name: 'Table' },
        { id: 'report', name: 'Report' },
      ],
      relationshipTypes: [rel('FLOWS_TO', 'Flows To', ['table'], ['table', 'report'])],
      containmentEdgeTypes: ['CONTAINS'],
    } as unknown as WorkspaceSchema,
  })
}

function renderPanel(selection: string[]) {
  const onCreate = vi.fn(() => ({ staged: 0, rejected: [] }))
  const onClose = vi.fn()
  render(<BulkLinkPanel selection={selection} labelFor={(id) => id} onCreate={onCreate} onClose={onClose} />)
  return { onCreate, onClose }
}

const pickByText = (name: string) => {
  const list = screen.getByRole('region', { name: 'Other side' })
  const row = within(list).getByText(name).closest('label')!
  fireEvent.click(row.querySelector('input')!)
}
const preview = () => screen.getByRole('region', { name: 'Preview' })

beforeEach(() => seed())

describe('BulkLinkPanel', () => {
  it('N sources → 1 target: previews each link, and hands exactly those to be staged', () => {
    const { onCreate, onClose } = renderPanel(['t1', 't2'])
    pickByText('r1')
    expect(within(preview()).getByText('2 links will be added')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Flows To.*fits 2 of 2/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 links' }))
    expect(onCreate).toHaveBeenCalledWith([{ source: 't1', target: 'r1' }, { source: 't2', target: 'r1' }], 'FLOWS_TO')
    expect(onClose).toHaveBeenCalled()
  })

  it('swapping the direction reverses every pair — and the ontology is judged the other way round', () => {
    renderPanel(['t1', 't2'])
    pickByText('r1')
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }))
    // A report cannot be the source of Flows To: nothing fits, and the panel says why.
    expect(screen.getByText('No lineage relationship in the ontology can join these.')).toBeInTheDocument()
    expect(screen.getByText(/can't be the source/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add 0 links/ })).toBeDisabled()
  })

  it('1 source → N targets: the picked entity feeds the selection', () => {
    const { onCreate } = renderPanel(['r1', 'r2'])
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }))
    pickByText('t3')
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 links' }))
    expect(onCreate).toHaveBeenCalledWith([{ source: 't3', target: 'r1' }, { source: 't3', target: 'r2' }], 'FLOWS_TO')
  })

  it('a pair already linked is shown as skipped, with the reason, and is not handed over', () => {
    seed([{ source: 't1', target: 'r1', edgeType: 'FLOWS_TO' }])
    const { onCreate } = renderPanel(['t1', 't2'])
    pickByText('r1')
    expect(within(preview()).getByText('1 link will be added · 1 skipped')).toBeInTheDocument()
    expect(within(preview()).getByText(/already connected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 link' }))
    expect(onCreate).toHaveBeenCalledWith([{ source: 't2', target: 'r1' }], 'FLOWS_TO')
  })

  it('never offers a logical group, or the selection itself, as the other side', () => {
    renderPanel(['t1', 't2'])
    const list = screen.getByRole('region', { name: 'Other side' })
    expect(within(list).queryByText('logical:g')).toBeNull()
    expect(within(list).queryByText('t1')).toBeNull()
  })

  it('asks before adding more than 50 links', () => {
    seed([], 15)
    const { onCreate } = renderPanel(tables(6))
    for (const id of tables(15).slice(6)) pickByText(id) // 6 × 9 = 54
    fireEvent.click(screen.getByRole('button', { name: 'Add 54 links' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText('Add 54 links to your draft?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, add them' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect((onCreate.mock.calls[0] as unknown as [unknown[]])[0]).toHaveLength(54)
  })

  it('refuses a batch over the limit, and says how to fix it', () => {
    seed([], 46)
    renderPanel(tables(26))
    for (const id of tables(46).slice(26)) pickByText(id) // 26 × 20 = 520
    expect(screen.getByText(/a batch holds at most 500/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add 520 links' })).toBeDisabled()
  })
})
