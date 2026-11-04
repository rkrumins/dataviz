/**
 * The layer header in a draft. The Business view keeps it to the layer itself
 * (fold, icon, name, count, sort) and puts adding, grouping, building and
 * deleting in the layer's menu, behind ⋯; the Technical view keeps them inline.
 * In either view a layer with properties says so, and its card lists them.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'

const layer: ViewLayerConfig = {
  id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
  properties: { owner: 'data-eng', sla: '4h' },
}

function renderHeader(extra: Partial<React.ComponentProps<typeof LayerColumn>> = {}) {
  const session = stubSession()
  const actions = {
    onHeaderContextMenu: vi.fn(),
    onAddToLayer: vi.fn(),
    onCreateGroup: vi.fn(),
    onBuildToLayer: vi.fn(),
    onDeleteLayer: vi.fn(),
  }
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer}
          schema={null}
          nodes={[]}
          selectedNodeId={null}
          expandedNodes={new Set<string>()}
          searchResults={new Set<string>()}
          onSelect={vi.fn()}
          onSelectRange={vi.fn()}
          onToggle={vi.fn()}
          onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()}
          traceFocusId={null}
          traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()}
          overscan={200}
          {...actions}
          {...extra}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
  return actions
}

beforeEach(() => { installJsdomLayout() })

describe('LayerColumn header', () => {
  it('in the Business view, keeps to the layer and opens its menu from ⋯', () => {
    usePersonaStore.setState({ mode: 'business' })
    const actions = renderHeader()
    expect(screen.queryByRole('button', { name: 'Add entity to Data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New group in Data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Build a lot at once in Data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete Data' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Data: layer actions' }))
    expect(actions.onHeaderContextMenu).toHaveBeenCalledWith(expect.anything(), 'L1')
  })

  it('in the Technical view, keeps every action inline', () => {
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Data: layer actions' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add entity to Data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New group in Data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build a lot at once in Data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Data' })).toBeInTheDocument()
  })

  it('starts naming a new group when its menu asks', () => {
    usePersonaStore.setState({ mode: 'business' })
    const session = stubSession()
    const column = (nonce: number) => (
      <ViewSearchSessionContext.Provider value={session}>
        <ViewRowSearchContext.Provider value={session.rowSearch}>
          <LayerColumn
            layer={layer} schema={null} nodes={[]} selectedNodeId={null}
            expandedNodes={new Set<string>()} searchResults={new Set<string>()}
            onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()}
            onDoubleClick={vi.fn()} traceFocusId={null} traceNodes={new Set<string>()}
            traceContextSet={new Set<string>()} overscan={200}
            onCreateGroup={vi.fn()} newGroupNonce={nonce}
          />
        </ViewRowSearchContext.Provider>
      </ViewSearchSessionContext.Provider>
    )
    const { rerender } = render(column(0))
    expect(screen.queryByRole('textbox', { name: 'Name the new group in Data' })).toBeNull()
    rerender(column(1))
    expect(screen.getByRole('textbox', { name: 'Name the new group in Data' })).toBeInTheDocument()
  })

  it('says a layer has properties, and its card lists them', async () => {
    renderHeader()
    const badge = screen.getByRole('img', { name: '2 properties' })
    fireEvent.mouseEnter(badge.closest('h3')!.parentElement!)
    const card = await screen.findByRole('tooltip')
    expect(card).toHaveTextContent('Owner')
    expect(card).toHaveTextContent('data-eng')
    expect(card).toHaveTextContent('4h')
  })
})
