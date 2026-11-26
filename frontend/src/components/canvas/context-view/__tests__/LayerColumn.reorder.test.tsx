/**
 * Reordering columns by dragging a column's header. The whole header is the handle — not only its
 * small icon tile — and while a column hovers over another, the hint says where it will land:
 * "Move after Apps" when it comes from the left, "Move before Apps" from the right. Arranging is a
 * view change, said as one.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import { setDraggedLayer } from '../layerDrag'

function renderColumn(layer: Partial<ViewLayerConfig>, onReorderLayer = vi.fn()) {
  const session = stubSession()
  const full: ViewLayerConfig = { id: 'apps', name: 'Apps', entityTypes: [], order: 1, color: '#4488ff', ...layer }
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={full} schema={null} nodes={[]} selectedNodeId={null}
          expandedNodes={new Set<string>()} searchResults={new Set<string>()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()} traceFocusId={null} traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()} overscan={200}
          onRenameLayer={vi.fn()} onSetSortMode={vi.fn()} onFoldChange={vi.fn()}
          onReorderLayer={onReorderLayer}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
  return { onReorderLayer, header: screen.getByRole('group', { name: full.name }) }
}

const layerDrag = (id: string) => ({
  types: ['text/x-layer-id'],
  getData: (k: string) => (k === 'text/x-layer-id' ? id : ''),
  setData: vi.fn(), dropEffect: 'move', effectAllowed: 'move',
})

beforeEach(() => {
  installJsdomLayout()
  usePersonaStore.setState({ mode: 'technical' })
})
afterEach(() => setDraggedLayer(null))

describe('reordering columns by their header', () => {
  it('starts a drag from anywhere on the header, carrying the column', () => {
    const { header } = renderColumn({})
    expect(header).toHaveAttribute('draggable', 'true')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(header, { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/x-layer-id', 'apps')
  })

  it('says it lands after a column it comes to from the left, and drops there', () => {
    const { header, onReorderLayer } = renderColumn({})
    setDraggedLayer({ id: 'fin', order: 0 })
    fireEvent.dragOver(header, { dataTransfer: layerDrag('fin') })
    expect(document.querySelector('[data-drop-hint]')).toHaveTextContent('Move after Apps·only this view')
    fireEvent.drop(header, { dataTransfer: layerDrag('fin') })
    expect(onReorderLayer).toHaveBeenCalledWith('fin', 'apps')
  })

  it('says it lands before a column it comes to from the right', () => {
    const { header } = renderColumn({})
    setDraggedLayer({ id: 'domains', order: 2 })
    fireEvent.dragOver(header, { dataTransfer: layerDrag('domains') })
    expect(document.querySelector('[data-drop-hint]')).toHaveTextContent('Move before Apps·only this view')
  })

  it('offers nothing over its own header', () => {
    const { header } = renderColumn({})
    setDraggedLayer({ id: 'apps', order: 1 })
    fireEvent.dragOver(header, { dataTransfer: layerDrag('apps') })
    expect(document.querySelector('[data-drop-hint]')).toBeNull()
  })
})
