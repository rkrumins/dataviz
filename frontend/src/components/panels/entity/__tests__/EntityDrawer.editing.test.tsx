/**
 * EntityDrawer — an entity is edited only where the edit can be kept, in a
 * draft. Anywhere else the Edit tab is disabled and says why (or, where a draft
 * can be opened, the drawer offers one), and the JSON is read-only; staging an
 * edit says it still needs Review & Save, never that it was saved.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    NO_DRAFT, NO_VERSION_CONTROL, type EntityEditing,
} from '@/features/versioning/hooks/useEntityEditing'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

import { EntityDrawer } from '../EntityDrawer'


let editing: EntityEditing

vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
    useEntityEditing: () => editing,
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

function openDrawer(props: Parameters<typeof EntityDrawer>[0] = {}) {
    useCanvasStore.setState({
        nodes: [NODE], drawerNodeId: NODE.id, drawerEdge: null, drawerDirty: false, pendingDrawerMove: null,
    })
    render(<EntityDrawer {...props} />)
}

beforeEach(() => {
    editing = { offered: true, blocked: null }
    useStagedChangesStore.setState({ changes: [], redoStack: [] })
})


describe('EntityDrawer — editing is kept only in a draft', () => {
    it('stages an edit made in a draft, and says it still needs Review & Save', async () => {
        const user = userEvent.setup()
        openDrawer({ canEdit: true })
        await user.click(screen.getByRole('tab', { name: 'Edit' }))
        const name = screen.getByPlaceholderText('Entity name…')
        await user.clear(name)
        await user.type(name, 'Orders v2')
        await user.click(screen.getByRole('button', { name: /Stage changes/ }))

        expect(useStagedChangesStore.getState().changes).toHaveLength(1)
        expect(screen.getByText(/Review & Save to keep it/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Review & Save' })).toBeInTheDocument()
        expect(screen.queryByText(/saved successfully/)).not.toBeInTheDocument()
    })

    it('disables Edit where the data source has no version control, and says why', async () => {
        editing = { offered: true, blocked: NO_VERSION_CONTROL }
        const user = userEvent.setup()
        // A draft can't be opened on an unversioned source, so none is offered.
        openDrawer({ onStartEditing: vi.fn() })
        const edit = screen.getByRole('tab', { name: 'Edit' })
        expect(edit).toBeDisabled()
        expect(screen.queryByRole('button', { name: /Edit in a draft/ })).not.toBeInTheDocument()
        await user.hover(edit.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_VERSION_CONTROL)

        await user.click(screen.getByRole('tab', { name: 'JSON' }))
        expect(screen.getByLabelText('Entity data as JSON').tagName).toBe('PRE')
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('with no draft open, offers one where the canvas can open it — else says why', () => {
        editing = { offered: true, blocked: NO_DRAFT }
        openDrawer({ onStartEditing: vi.fn() })
        expect(screen.getByRole('button', { name: /Edit in a draft/ })).toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: 'Edit' })).not.toBeInTheDocument()
    })

    it('offers no Edit tab where editing is off', () => {
        editing = { offered: false, blocked: null }
        openDrawer({ canEdit: true, onStartEditing: vi.fn() })
        expect(screen.queryByRole('tab', { name: 'Edit' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Edit in a draft/ })).not.toBeInTheDocument()
    })
})
