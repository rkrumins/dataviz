/**
 * Add types to my data model: names what the file uses that the reader's own data model lacks,
 * adds them in one go, and says what that made — in place on a draft, or a new published version
 * with the reader's graphs moved to it. A refusal is said in plain words, and can be tried again.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerTypesAdded, LayerTypesToAdd } from '@/services/playgroundService'

const { addLayerTypes } = vi.hoisted(() => ({ addLayerTypes: vi.fn() }))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { addLayerTypes } }))

import { AddTypesToMyLayer } from '../AddTypesToMyLayer'

const MISSING: LayerTypesToAdd = {
    entityTypes: [{ name: 'Machine' }, { name: 'Sensor' }],
    relationshipTypes: [{ name: 'MEASURES', ends: [['Sensor', 'Machine']] }],
}
const added = (over: Partial<LayerTypesAdded> = {}): LayerTypesAdded => ({
    ontologyId: 'own_v1', version: 1, movedGraphs: 0,
    entityTypeIds: { Machine: 'machine', Sensor: 'sensor' }, relationshipTypeIds: { MEASURES: 'MEASURES' }, ...over,
})

const onAdded = vi.fn()
function renderIt(missing: LayerTypesToAdd = MISSING) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <AddTypesToMyLayer ontologyId="own_v1" missing={missing} onAdded={onAdded} />
        </QueryClientProvider>,
    )
}

beforeEach(() => vi.clearAllMocks())

describe('AddTypesToMyLayer', () => {
    it('names the types to add, and adds them to a draft in place', async () => {
        addLayerTypes.mockResolvedValue(added())
        renderIt()
        expect(screen.getByText('Add 3 types to your data model:').parentElement).toHaveTextContent('Machine, Sensor, MEASURES')
        await userEvent.click(screen.getByRole('button', { name: 'Add to my data model' }))
        expect(addLayerTypes).toHaveBeenCalledWith('own_v1', MISSING)
        expect(await screen.findByRole('status')).toHaveTextContent('Added to your data model.')
        expect(onAdded).toHaveBeenCalledWith(added())
        expect(screen.queryByRole('button', { name: 'Add to my data model' })).toBeNull()
    })

    it('says when a published one got a new version, and how many graphs moved to it', async () => {
        const result = added({ ontologyId: 'own_v2', version: 2, movedGraphs: 3 })
        addLayerTypes.mockResolvedValue(result)
        renderIt()
        await userEvent.click(screen.getByRole('button', { name: 'Add to my data model' }))
        const status = await screen.findByRole('status')
        expect(status).toHaveTextContent('Your data model is now v2, a new version, published.')
        expect(status).toHaveTextContent('3 graphs of yours moved to it.')
        expect(onAdded).toHaveBeenCalledWith(result)
    })

    it('counts the rest past six names', () => {
        renderIt({ entityTypes: 'ABCDEFGH'.split('').map(name => ({ name })), relationshipTypes: [] })
        expect(screen.getByText('Add 8 types to your data model:').parentElement).toHaveTextContent('A, B, C, D, E, F, and 2 more')
    })

    it('shows nothing when nothing is missing', () => {
        const { container } = renderIt({ entityTypes: [], relationshipTypes: [] })
        expect(container).toBeEmptyDOMElement()
    })

    it('says why it was refused, and can be tried again', async () => {
        addLayerTypes.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403, detail: { type: 'layer_not_yours' } }))
        addLayerTypes.mockResolvedValueOnce(added())
        renderIt()
        await userEvent.click(screen.getByRole('button', { name: 'Add to my data model' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Only the person who made this data model can change it.')
        expect(onAdded).not.toHaveBeenCalled()

        await userEvent.click(screen.getByRole('button', { name: 'Add to my data model' }))
        expect(await screen.findByRole('status')).toHaveTextContent('Added')
        expect(onAdded).toHaveBeenCalledTimes(1)
    })
})
