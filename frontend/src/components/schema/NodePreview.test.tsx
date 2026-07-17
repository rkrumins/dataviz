/**
 * NodePreview — the live preview must render a real GenericNode from the
 * editor's unsaved form state without crashing, for ANY form the editor can
 * produce (regression: graph-discovered types crashed the Appearance tab
 * with "Cannot read properties of undefined (reading 'behavior')").
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { NodePreview } from './NodePreview'
import type { EntityTypeSchema } from '@/types/schema'

// React Flow needs a viewport + ResizeObserver in jsdom (same pattern as
// ConflictResolver.test.tsx).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const SENTINEL: EntityTypeSchema = {
  id: 'SentinelMarker',
  name: 'SentinelMarker',
  pluralName: 'SentinelMarkers',
  description: 'Entity type discovered in graph: SentinelMarker',
  visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
}

describe('NodePreview', () => {
  it('renders a graph-discovered type without crashing', () => {
    render(<NodePreview entityType={SENTINEL} />)
    expect(screen.getByText('Example SentinelMarker')).toBeInTheDocument()
  })

  it('survives a form whose behavior block is missing (defensive: legacy defs)', () => {
    const { behavior: _b, ...rest } = SENTINEL
    render(<NodePreview entityType={rest as EntityTypeSchema} />)
    expect(screen.getByText('Example SentinelMarker')).toBeInTheDocument()
  })
})
