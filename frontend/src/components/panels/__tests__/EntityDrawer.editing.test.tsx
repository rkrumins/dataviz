/**
 * EntityDrawer — an entity is edited only where the edit can be kept, in a
 * draft. Anywhere else the Edit tab is disabled and says why, and the raw
 * JSON is read-only; staging an edit says it still needs Review & Save,
 * never that it was saved.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    NO_VERSION_CONTROL, type EntityEditing,
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
    useEntityHistory: () => ({ data: undefined, isLoading: false }),
    useProjectionWatermark: () => ({ data: undefined }),
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({ EntityHistory: () => null }))
vi.mock('@/components/panels/LineageNeighbors', () => ({ LineageNeighbors: () => null }))

const NODE = {
    id: 'urn:li:dataset:orders',
    type: 'generic',
    position: { x: 0, y: 0 },
    data: { label: 'Orders', type: 'dataset', urn: 'urn:li:dataset:orders' },
} as unknown as LineageNode

function openDrawer() {
    useCanvasStore.setState({ nodes: [NODE], drawerNodeId: NODE.id })
    render(<EntityDrawer />)
}

beforeEach(() => {
    editing = { offered: true, blocked: null }
    useStagedChangesStore.setState({ changes: [], redoStack: [] })
})


describe('EntityDrawer — editing is kept only in a draft', () => {
    it('stages an edit made in a draft, and says it still needs Review & Save', async () => {
        const user = userEvent.setup()
        openDrawer()
        await user.click(screen.getByRole('button', { name: 'Edit' }))
        const name = screen.getByPlaceholderText('Entity name...')
        await user.clear(name)
        await user.type(name, 'Orders v2')
        await user.click(screen.getByRole('button', { name: /Stage Changes/ }))

        expect(useStagedChangesStore.getState().changes).toHaveLength(1)
        expect(screen.getByText(/Review & Save to keep it/)).toBeInTheDocument()
        expect(screen.queryByText(/saved successfully/)).not.toBeInTheDocument()
    })

    it('disables Edit where the data source has no version control, and says why', async () => {
        editing = { offered: true, blocked: NO_VERSION_CONTROL }
        const user = userEvent.setup()
        openDrawer()
        const edit = screen.getByRole('button', { name: 'Edit' })
        expect(edit).toBeDisabled()
        await user.hover(edit.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_VERSION_CONTROL)

        await user.click(screen.getByRole('button', { name: 'JSON' }))
        expect(screen.getByRole('textbox')).toHaveAttribute('readonly')
    })

    it('offers no Edit tab where editing is off', () => {
        editing = { offered: false, blocked: null }
        openDrawer()
        expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    })
})
