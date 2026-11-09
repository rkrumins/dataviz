/**
 * EntityDrawer — where the canvas can't trace (its trace reads the graph as it is now, and a past
 * revision is open), the drawer keeps its three trace actions, disabled, and says why.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OFF_AT_REVISION } from '@/features/versioning/model/revisionCopy'
import { useCanvasStore, type LineageNode } from '@/store/canvas'

import { EntityDrawer } from '../EntityDrawer'


vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
    useEntityEditing: () => ({ offered: false, blocked: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
    useResolveGraph: () => ({ data: undefined, isError: false }),
    useEntitySummary: () => ({ data: undefined, isLoading: false }),
    useProjectionWatermark: () => ({ data: undefined }),
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({ EntityHistory: () => null }))
vi.mock('@/components/panels/LineageNeighbors', () => ({ LineageNeighbors: () => null }))
vi.mock('@/components/canvas/context-view/useReparentNode', () => ({ useReparentNode: () => ({ reparent: vi.fn() }) }))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => vi.fn() }))

const NODE = {
    id: 'urn:li:dataset:orders',
    type: 'generic',
    position: { x: 0, y: 0 },
    data: { label: 'Orders', type: 'dataset', urn: 'urn:li:dataset:orders' },
} as unknown as LineageNode

const TRACES = [/^Root Cause/, /^Impact/, /^Full Lineage/]

function openDrawer(props: Parameters<typeof EntityDrawer>[0]) {
    useCanvasStore.setState({
        nodes: [NODE], drawerNodeId: NODE.id, drawerEdge: null, drawerDirty: false, pendingDrawerMove: null,
    })
    render(<EntityDrawer {...props} />)
}

const traces = { onTraceUp: vi.fn(), onTraceDown: vi.fn(), onFullTrace: vi.fn() }

beforeEach(() => {
    Object.values(traces).forEach((fn) => fn.mockClear())
})


describe('EntityDrawer — the trace actions where the canvas can’t trace', () => {
    it('are kept, disabled, and say why', () => {
        openDrawer({ ...traces, traceBlocked: OFF_AT_REVISION })
        for (const name of TRACES) {
            const button = screen.getByRole('button', { name })
            expect(button).toBeDisabled()
            expect(button).toHaveAttribute('title', OFF_AT_REVISION)
            fireEvent.click(button)
        }
        Object.values(traces).forEach((fn) => expect(fn).not.toHaveBeenCalled())
    })

    it('trace where the canvas can', () => {
        openDrawer(traces)
        const up = screen.getByRole('button', { name: TRACES[0] })
        expect(up).toBeEnabled()
        expect(up).not.toHaveAttribute('title')
        fireEvent.click(up)
        expect(traces.onTraceUp).toHaveBeenCalledWith(NODE.id)
    })
})
