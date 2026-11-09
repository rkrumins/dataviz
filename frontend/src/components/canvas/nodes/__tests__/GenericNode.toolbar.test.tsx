/**
 * The selected card's toolbar on the Graph canvas. Its buttons work: the
 * trace pair traces from the card, and More opens the card's right-click
 * menu, in the Technical view only. Nothing pins a card, so there is no Pin.
 * Add inside is offered only where the canvas lets this person edit.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { GenericNode } from '../GenericNode'
import { OFF_AT_REVISION } from '@/features/versioning/model/revisionCopy'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { usePersonaStore } from '@/store/persona'
import type { EntityTypeSchema } from '@/types/schema'

// React Flow needs a viewport + ResizeObserver in jsdom (same stubs as
// NodePreview.test.tsx, which mounts a real GenericNode the same way).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

// Traceable, and able to hold others: a type with every toolbar button.
const schemaType: EntityTypeSchema = {
  id: 'schema',
  name: 'Schema',
  pluralName: 'Schemas',
  description: 'Holds tables',
  visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: 0, canContain: ['table'], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: false, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
}

const nodeTypes = { generic: GenericNode }

/** A selected card, with what the host canvas injects into its data. */
function renderCard(host: Record<string, unknown> = {}) {
  const schema: ResolvedViewSchema = {
    entityTypes: [schemaType],
    relationshipTypes: [],
    containmentEdgeTypes: [],
    lineageEdgeTypes: [],
    rootEntityTypes: [],
  }
  const nodes: Node[] = [{
    id: 'n1',
    type: 'generic',
    position: { x: 0, y: 0 },
    selected: true,
    data: { id: 'n1', typeId: 'schema', name: 'Sales', urn: 'urn:li:schema:sales', ...host },
  }]
  render(
    <StaticViewSchemaProvider schema={schema}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} proOptions={{ hideAttribution: true }} />
      </ReactFlowProvider>
    </StaticViewSchemaProvider>,
  )
}

describe('GenericNode — the selected card’s toolbar', () => {
  it('offers details and both traces in the Business view, and no More or Pin', () => {
    usePersonaStore.setState({ mode: 'business' })
    renderCard({ onTraceUpstream: vi.fn(), onTraceDownstream: vi.fn(), onOpenMenu: vi.fn() })
    expect(screen.getByRole('button', { name: 'Open details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace Upstream' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace Downstream' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
  })

  it('traces up and down from the card', () => {
    usePersonaStore.setState({ mode: 'business' })
    const onTraceUpstream = vi.fn()
    const onTraceDownstream = vi.fn()
    renderCard({ onTraceUpstream, onTraceDownstream })
    fireEvent.click(screen.getByRole('button', { name: 'Trace Upstream' }))
    expect(onTraceUpstream).toHaveBeenCalledWith('n1')
    expect(onTraceDownstream).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Trace Downstream' }))
    expect(onTraceDownstream).toHaveBeenCalledWith('n1')
  })

  it('keeps the trace pair, disabled, where the canvas can’t trace, and says why', () => {
    const onTraceUpstream = vi.fn()
    const onTraceDownstream = vi.fn()
    renderCard({ onTraceUpstream, onTraceDownstream, traceBlocked: OFF_AT_REVISION })
    for (const name of ['Trace Upstream', 'Trace Downstream']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', OFF_AT_REVISION)
      fireEvent.click(button)
    }
    expect(onTraceUpstream).not.toHaveBeenCalled()
    expect(onTraceDownstream).not.toHaveBeenCalled()
  })

  it('opens the card’s menu from More in the Technical view', () => {
    const onOpenMenu = vi.fn()
    renderCard({ onOpenMenu })
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
    expect(onOpenMenu.mock.calls[0][1]).toBe('n1')
  })

  it('offers no Add inside where the canvas does not let this person edit', () => {
    renderCard()
    expect(screen.queryByRole('button', { name: 'Add inside Sales' })).toBeNull()
  })

  it('offers Add inside where the canvas lets this person edit', () => {
    renderCard({ canAddInside: true })
    expect(screen.getByRole('button', { name: 'Add inside Sales' })).toBeInTheDocument()
  })
})
