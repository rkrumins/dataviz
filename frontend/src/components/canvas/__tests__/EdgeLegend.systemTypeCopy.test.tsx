/**
 * The legend's fallback row must not undo its own label.
 *
 * A projected edge type that the schema-derived definitions do not carry —
 * the aggregation worker's AGGREGATED is exactly that case — is rendered
 * from a synthetic fallback definition built in the component. Its label
 * reads the plain-English copy; its description used to read
 * "Relationship type: AGGREGATED", putting the raw id back one line under
 * the word that replaced it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/canvas', () => ({
    useCanvasStore: (selector: (s: { edges: unknown[] }) => unknown) => selector({ edges: [] }),
}))

vi.mock('@/hooks/useEdgeFilters', () => ({
    useEdgeFiltersStore: () => ({
        highlightedEdgeIds: new Set<string>(),
        setHighlightedEdges: vi.fn(),
        clearHighlightedEdges: vi.fn(),
        filters: [],
        toggleFilter: vi.fn(),
    }),
}))

vi.mock('@/hooks/useViewSchema', () => ({
    useViewRelationshipTypes: () => [],
    useViewContainmentEdgeTypes: () => [],
}))

import { EdgeLegend } from '../EdgeLegend'


describe('EdgeLegend fallback row for a synthetic type', () => {
    it('describes the system type in the same words as its label', () => {
        render(
            <EdgeLegend
                defaultExpanded
                visibleEdges={[{ id: 'e1', types: ['AGGREGATED'], edgeCount: 4 }]}
            />
        )

        expect(screen.getByText('Combined flow')).toBeTruthy()
        expect(
            screen.getByText('Many detailed flows between two items, shown as one connection.')
        ).toBeTruthy()
        expect(screen.queryByText('Relationship type: AGGREGATED')).toBeNull()
    })

    it('a type with no copy of its own keeps the generated description', () => {
        render(
            <EdgeLegend
                defaultExpanded
                visibleEdges={[{ id: 'e1', types: ['FLOWS_TO'], edgeCount: 1 }]}
            />
        )

        expect(screen.getByText('Relationship type: FLOWS_TO')).toBeTruthy()
    })
})
