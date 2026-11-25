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
import { useHierarchyBuilderStore } from '../../hierarchyBuilderStore'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePersonaStore } from '@/store/persona'

afterEach(() => {
  useBuildRowsStore.getState().reset()
  useHierarchyBuilderStore.setState({ parentUrn: null, layerId: null, initialTypeId: null, askParent: false, choices: [], topLevelTypeId: null })
  usePersonaStore.setState({ mode: 'technical' })
})

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

describe('BuildPanel — where its top-level rows go', () => {
  const type = (id: string, name: string, canContain: string[], canBeContainedBy: string[], level: number) => ({
    id, name, pluralName: `${name}s`, visual: {}, fields: [], behavior: {},
    hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
  })
  const seed = () => {
    useSchemaStore.setState({
      activeViewId: null,
      schema: {
        id: 's', name: 's', version: '1', views: [], defaultViewId: '', globalVisuals: {},
        entityTypes: [type('domain', 'Domain', ['app'], [], 0), type('app', 'App', [], ['domain'], 1)],
        relationshipTypes: [{ id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true }],
        containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: [], rootEntityTypes: ['domain'],
      },
    } as never)
    useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
    useCanvasStore.getState().addNodes(['Finance', 'Sales'].map((name) => ({
      id: `urn:${name}`, type: 'generic', position: { x: 0, y: 0 },
      data: { label: name, businessLabel: `${name} team`, type: 'domain', urn: `urn:${name}` },
    })))
  }

  it('asked where an "Apps" layer\'s rows go: the question first, Apply waits, and a pick answers it', () => {
    seed()
    useHierarchyBuilderStore.setState({
      parentUrn: null, layerId: 'apps', initialTypeId: 'app', askParent: true,
      choices: [{ urn: 'urn:Finance', typeId: 'domain' }, { urn: 'urn:Sales', typeId: 'domain' }], topLevelTypeId: 'domain',
    })
    useBuildRowsStore.getState().setRows([makeRow({ id: 'r', name: 'Billing' })])
    render(<BuildPanel onClose={() => {}} layerId="apps" typeLayerMap={new Map([['app', 'apps']])} />)

    expect(screen.getByTestId('build-scope')).toHaveTextContent('Choose a parent for these Apps')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByText('Choose where these go to apply them')).toBeInTheDocument()
    const picker = screen.getByRole('listbox', { name: 'Where to add' })
    expect(picker).toHaveTextContent('Can hold an App')

    fireEvent.click(screen.getByRole('option', { name: /Finance/ }))
    expect(useHierarchyBuilderStore.getState()).toMatchObject({ parentUrn: 'urn:Finance', askParent: false })
    expect(screen.getByTestId('build-scope')).toHaveTextContent('Adding inside Finance · Domain')
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled()
    // Not pinned to the Apps column: rows added inside an entity go where it is.
    expect(screen.getByText('These go inside Finance.')).toBeInTheDocument()
  })

  it('inside a layer\'s node, Change moves it — to the top level too', () => {
    seed()
    usePersonaStore.setState({ mode: 'business' })
    useHierarchyBuilderStore.setState({
      parentUrn: 'urn:Finance', layerId: null, initialTypeId: 'app', askParent: false,
      choices: [{ urn: 'urn:Finance', typeId: 'domain' }], topLevelTypeId: 'domain',
    })
    render(<BuildPanel onClose={() => {}} />)

    // The business view names it as the business does, without its type.
    expect(screen.getByTestId('build-scope')).toHaveTextContent(/^Adding inside Finance teamChange$/)
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('option', { name: /A new Domain, on its own/ }))
    expect(useHierarchyBuilderStore.getState().parentUrn).toBeNull()
    expect(screen.getByTestId('build-scope')).toHaveTextContent('Adding at the top level')
  })
})
