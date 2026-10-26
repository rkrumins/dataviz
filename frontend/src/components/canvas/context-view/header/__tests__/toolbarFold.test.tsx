/**
 * The header's actions fold their words away, least-used first, when the
 * row can't hold them beside the search box — and move under it when even
 * that isn't enough. jsdom lays nothing out, so the decision is tested as
 * the pure function it is, and the buttons for what folding does to them.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ComprehensionTools } from '../ViewerActions'
import { foldToolbar, SEARCH_MIN, SEARCH_ROOM, ToolbarFoldProvider } from '../toolbarFold'


/** Seven actions in fold order, each saving 50px when folded. */
const ITEMS = ['select', 'lens', 'properties', 'display', 'lineage', 'trace', 'edit']
    .map((id) => ({ id, saving: 50 }))
const LABELLED = 1000
const fold = (row: number, lead = 130, gap = 16) =>
    foldToolbar({ row, lead, gap, labelled: LABELLED, items: ITEMS })
/** The row at which the labelled actions just fit beside a roomy search. */
const ROOMY = LABELLED + 130 + SEARCH_ROOM + 32

describe('foldToolbar', () => {
    it('folds nothing while the row is unmeasured, or roomy enough', () => {
        expect(foldToolbar({ row: 0, lead: 0, gap: 16, labelled: LABELLED, items: ITEMS }))
            .toEqual({ folded: new Set(), stacked: false })
        expect(fold(ROOMY)).toEqual({ folded: new Set(), stacked: false })
    })

    it('folds the least-used first, as few as make room for the search box', () => {
        expect([...fold(ROOMY - 1).folded]).toEqual(['select'])
        expect([...fold(ROOMY - 120).folded]).toEqual(['select', 'lens', 'properties'])
        expect(fold(ROOMY - 120).stacked).toBe(false)
    })

    it('folds everything and lets the search box give way before stacking', () => {
        const allFolded = LABELLED - 7 * 50
        const r = fold(allFolded + 130 + SEARCH_MIN + 32)
        expect(r).toEqual({ folded: new Set(ITEMS.map((i) => i.id)), stacked: false })
    })

    it('moves the actions under the search box when not even that fits, folding only what its own line needs', () => {
        const r = fold(700)
        expect(r.stacked).toBe(true)
        // On a 700px line of their own, six labels have to go.
        expect([...r.folded]).toEqual(['select', 'lens', 'properties', 'display', 'lineage', 'trace'])
    })
})

describe('a folded action', () => {
    const props = {
        showLineageFlow: true, onToggleLineageFlow: vi.fn(),
        canvasZoom: 1, onSetCanvasZoom: vi.fn(), canvasDensity: 'spacious' as const, onSetCanvasDensity: vi.fn(),
        showCanvasTypeBadge: true, onToggleCanvasTypeBadge: vi.fn(),
        subtleCanvasTreeLines: false, onToggleSubtleCanvasTreeLines: vi.fn(), onResetCanvasDisplaySettings: vi.fn(),
        lineageRenderMode: 'stubs' as const, onSetLineageRenderMode: vi.fn(),
        showEdgeDirection: false, onToggleEdgeDirection: vi.fn(),
        traceActive: false, canTrace: true, onStartTrace: vi.fn(), onExitTrace: vi.fn(), lineageReady: true,
        traceUpstreamDepth: 3, traceDownstreamDepth: 3, onSetTraceDepth: vi.fn(),
        onToggleMultiSelect: vi.fn(), isDraft: false,
    }

    it('shows its icon alone and keeps its name; the others keep their words', () => {
        render(
            <ToolbarFoldProvider value={new Set(['select', 'lineage'])}>
                <ComprehensionTools {...props} />
            </ToolbarFoldProvider>,
        )
        const select = screen.getByRole('button', { name: 'Select' })
        expect(select.querySelector('[data-toolbar-label]')).toHaveClass('sr-only')
        expect(select).toHaveClass('px-2.5')
        const lineage = document.querySelector('[data-toolbar-item="lineage"]')!
        expect(lineage).toHaveAccessibleName('Lineage')
        expect(lineage.querySelector('[data-toolbar-label]')).toHaveClass('sr-only')
        const display = screen.getByRole('button', { name: /Display/ })
        expect(display.querySelector('[data-toolbar-label]')).not.toHaveClass('sr-only')
    })

    it('keeps its words outside the header', () => {
        render(<ComprehensionTools {...props} />)
        expect(screen.getByRole('button', { name: 'Select' }).querySelector('[data-toolbar-label]'))
            .not.toHaveClass('sr-only')
    })
})
