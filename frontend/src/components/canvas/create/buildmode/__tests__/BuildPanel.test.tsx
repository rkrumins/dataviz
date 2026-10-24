/**
 * BuildPanel — flag-on, it hands the canvas's contractRowLayer (Apply's own call for a top-level
 * row) to the Grid and the Paste preview, so they agree with where Apply puts a row. Its footer
 * asks it for every row, so a nested row its own rule sends to another column stops it naming one.
 * Grid and Paste are reduced to the prop. An Apply that staged nothing (no draft could be opened)
 * keeps the rows and the panel.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useBuildRowsStore } from '../buildRowsStore'
import { makeRow } from '../buildRow'

const seen = vi.hoisted(() => ({ grid: undefined as unknown, paste: undefined as unknown }))
vi.mock('../BuildGrid', () => ({
  BuildGrid: (p: { contractRowLayer?: unknown }) => { seen.grid = p.contractRowLayer; return null },
}))
vi.mock('../BuildPaste', () => ({
  BuildPaste: (p: { contractRowLayer?: unknown }) => { seen.paste = p.contractRowLayer; return null },
}))

const stageBuildRows = vi.hoisted(() => vi.fn())
vi.mock('../stageBuildRows', () => ({ useStageBuildRows: () => ({ stageBuildRows }) }))
// Every row is stageable here: Apply's own staging is what is under test, not the ontology checks.
vi.mock('../applyBuild', () => ({ filterStageableRows: (rows: unknown[]) => rows }))

import { BuildPanel } from '../BuildPanel'

afterEach(() => useBuildRowsStore.getState().reset())

describe('BuildPanel', () => {
  it('hands contractRowLayer to the Grid and the Paste preview', () => {
    const contractRowLayer = () => 'b'
    render(<BuildPanel onClose={() => {}} contractRowLayer={contractRowLayer} />)
    fireEvent.click(screen.getByRole('tab', { name: /Grid/ }))
    expect(seen.grid).toBe(contractRowLayer)
    fireEvent.click(screen.getByRole('tab', { name: /Paste/ }))
    expect(seen.paste).toBe(contractRowLayer)
  })

  it('names the column contractRowLayer picks for a top-level row in its footer, not the type map\'s', () => {
    useReferenceModelStore.getState().setLayers([
      { id: 'a', name: 'Layer A', entityTypes: ['dataset'], order: 0 },
      { id: 'b', name: 'Layer B', entityTypes: [], order: 1 },
    ])
    useBuildRowsStore.getState().setRows([makeRow({ id: 'r', name: 'raw_orders', typeId: 'dataset' })])
    render(<BuildPanel onClose={() => {}} typeLayerMap={new Map([['dataset', 'a']])}
      contractRowLayer={(row) => (row.name.startsWith('raw') ? 'b' : 'a')} />)
    expect(screen.getByText('These land in Layer B.')).toBeInTheDocument()
  })

  it('names no single column when a nested row\'s own rule sends it elsewhere', () => {
    useReferenceModelStore.getState().setLayers([
      { id: 'a', name: 'Layer A', entityTypes: ['dataset'], order: 0 },
      { id: 'b', name: 'Layer B', entityTypes: [], order: 1 },
    ])
    useBuildRowsStore.getState().setRows([
      makeRow({ id: 'r', name: 'orders', typeId: 'dataset' }),
      makeRow({ id: 'c', name: 'raw_lines', typeId: 'dataset', parentId: 'r' }),
    ])
    render(<BuildPanel onClose={() => {}} typeLayerMap={new Map([['dataset', 'a']])}
      contractRowLayer={(row) => (row.name.startsWith('raw') ? 'b' : 'a')} />)
    expect(screen.getByText('Top-level entities go to their column; nested items stay under their parent.')).toBeInTheDocument()
  })

  it('keeps the rows and the panel when Apply staged nothing (no draft could be opened)', async () => {
    stageBuildRows.mockResolvedValue(new Map())
    const rows = [makeRow({ id: 'r', name: 'orders', typeId: 'dataset' })]
    useBuildRowsStore.getState().setRows(rows)
    const onClose = vi.fn()
    render(<BuildPanel onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(stageBuildRows).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(useBuildRowsStore.getState().rows).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
