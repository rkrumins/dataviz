/**
 * A card's ring and glow on the Graph canvas. Tailwind draws a ring as a box-shadow, so an inline
 * `box-shadow` on the card paints over it: every state's glow is a class, composed with its ring.
 */
import { render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { beforeAll, describe, expect, it } from 'vitest'

import { GenericNode } from '../GenericNode'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import type { EntityTypeSchema } from '@/types/schema'

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const table: EntityTypeSchema = {
  id: 'table', name: 'Table', pluralName: 'Tables', description: '',
  visual: { icon: 'Table', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: false, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
}
const schema: ResolvedViewSchema = {
  entityTypes: [table], relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: [],
}

/** The card's body: the element that draws its ring. */
function card(selected: boolean, data: Record<string, unknown> = {}): HTMLElement {
  const nodes: Node[] = [{
    id: 'n1', type: 'generic', position: { x: 0, y: 0 }, selected,
    data: { id: 'n1', typeId: 'table', name: 'Orders', urn: 'urn:li:table:orders', ...data },
  }]
  const { container } = render(
    <StaticViewSchemaProvider schema={schema}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ generic: GenericNode }} proOptions={{ hideAttribution: true }} />
      </ReactFlowProvider>
    </StaticViewSchemaProvider>,
  )
  return container.querySelector<HTMLElement>('.react-flow__node > div.relative')!
}

describe('GenericNode — rings', () => {
  it('a selected card shows its ring, in its type’s colour, and no inline box-shadow paints over it', () => {
    const el = card(true)
    expect(el.style.boxShadow).toBe('')
    expect(el.className).toContain('ring-2')
    expect(el.className).toContain('ring-[color:var(--ring-color)]')
    expect(el.style.getPropertyValue('--ring-color')).toBe('#6366f1')
  })

  it('a traced card’s ring shows too', () => {
    const el = card(false, { isTraced: true, isUpstream: true })
    expect(el.style.boxShadow).toBe('')
    expect(el.className).toContain('ring-blue-400')
  })

  it('a card at rest keeps its soft drop shadow', () => {
    const el = card(false)
    expect(el.style.boxShadow).toBe('')
    expect(el.className).toContain('shadow-[0_4px_12px_rgba(0,0,0,0.1)]')
  })
})
