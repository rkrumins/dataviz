import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type {
    PropertyPreview,
    PropertyStorageReport,
} from '@/services/propertyStorageService'

const getPropertyStorage = vi.fn()
const previewPropertyMapping = vi.fn()
const savePropertyMapping = vi.fn()

vi.mock('@/services/propertyStorageService', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/propertyStorageService')
    >('@/services/propertyStorageService')
    return {
        ...actual,
        getPropertyStorage: (...a: unknown[]) => getPropertyStorage(...a),
        previewPropertyMapping: (...a: unknown[]) => previewPropertyMapping(...a),
        savePropertyMapping: (...a: unknown[]) => savePropertyMapping(...a),
    }
})

import { PropertyMappingTab } from '../PropertyMappingTab'

const CONTAINER_REPORT: PropertyStorageReport = {
    containerKey: 'properties',
    separator: '/',
    collectUnmapped: true,
    propertyOverrides: {},
    labels: {
        dataset: {
            sampled: 200,
            storage: 'container',
            nativeKeys: [],
            containerKeys: ['properties'],
            inferredPaths: ['technical/format', 'technical/owner'],
            affectedNodes: 12043,
            unparseable: 0,
            collisions: [
                { field: 'level', samples: ['tier-1'], suggested: 'source/level' },
            ],
        },
    },
    totals: {
        labels: 1,
        affectedNodes: 12043,
        newPaths: 2,
        needsAlignment: ['dataset'],
    },
    elapsedMs: 12,
}

const PREVIEW: PropertyPreview = {
    count: 1,
    samples: [{
        urn: 'urn:x',
        label: 'dataset',
        displayName: 'Revenue',
        before: { properties: '{"technical":{"format":"parquet"}}' },
        after: { 'technical/format': 'parquet' },
        nativeAfter: ['technical/format'],
    }],
}

beforeEach(() => {
    vi.clearAllMocks()
    getPropertyStorage.mockResolvedValue(CONTAINER_REPORT)
    previewPropertyMapping.mockResolvedValue(PREVIEW)
    savePropertyMapping.mockResolvedValue({})
})

describe('PropertyMappingTab', () => {
    it('leads with how many nodes are affected and why it matters', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/12,043 nodes store their properties/i))
            .toBeInTheDocument()
        // The consequence, not just the count — this is the reason to act.
        expect(screen.getByText(/Advanced Search can't filter on them/i))
            .toBeInTheDocument()
    })

    it('reports storage per label with the paths unpacking would produce', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText('dataset')).toBeInTheDocument()
        expect(screen.getByText('Nested')).toBeInTheDocument()
        expect(screen.getByText(/technical\/format, technical\/owner/)).toBeInTheDocument()
    })

    it('surfaces a reserved-key collision with its sample value', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText('level')).toBeInTheDocument()
        expect(screen.getByText('tier-1')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Keep as source\/level/ }))
            .toBeInTheDocument()
    })

    it('renders the before/after preview through the real property editor', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText('Now')).toBeInTheDocument()
        const afterColumn = screen.getByText('With this mapping').parentElement!

        // The point of the whole preview: groupByPath turns the flat key
        // `technical/format` into a folder named `technical` holding `format`
        // — exactly what the entity drawer will render.
        await waitFor(() =>
            expect(within(afterColumn).getByText('technical')).toBeInTheDocument())
        expect(within(afterColumn).getByText('format')).toBeInTheDocument()
        // …and `before` shows the raw container instead.
        const beforeColumn = screen.getByText('Now').parentElement!
        expect(within(beforeColumn).getByText('properties')).toBeInTheDocument()

        expect(screen.getByText(/1 searchable/)).toBeInTheDocument()
    })

    it('says nothing needs doing when every label is already native', async () => {
        getPropertyStorage.mockResolvedValue({
            ...CONTAINER_REPORT,
            labels: {
                dataset: {
                    ...CONTAINER_REPORT.labels.dataset,
                    storage: 'native', affectedNodes: 0, collisions: [],
                },
            },
            totals: { labels: 1, affectedNodes: 0, newPaths: 0, needsAlignment: [] },
        })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/stores its properties as native fields/i))
            .toBeInTheDocument()
    })

    it('only offers to save once the mapping actually changes', async () => {
        const user = userEvent.setup()
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        await screen.findByText('dataset')
        expect(screen.queryByRole('button', { name: /Save Mapping/ })).toBeNull()

        await user.click(screen.getByRole('button', { name: /Keep as source\/level/ }))

        expect(await screen.findByRole('button', { name: /Save Mapping/ }))
            .toBeInTheDocument()
    })

    it('sends the edited mapping on save', async () => {
        const user = userEvent.setup()
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        await screen.findByText('dataset')
        await user.click(screen.getByRole('button', { name: /Keep as source\/level/ }))
        await user.click(await screen.findByRole('button', { name: /Save Mapping/ }))

        await waitFor(() => expect(savePropertyMapping).toHaveBeenCalled())
        expect(savePropertyMapping.mock.calls[0][2]).toMatchObject({
            containerKey: 'properties',
            propertyOverrides: { level: 'source/level' },
        })
    })

    it('offers no save controls without manage permission', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit={false} />)

        await screen.findByText('dataset')
        expect(screen.queryByRole('button', { name: /Save Mapping/ })).toBeNull()
    })

    it('warns that a non-slash separator loses the folder tree', async () => {
        getPropertyStorage.mockResolvedValue({ ...CONTAINER_REPORT, separator: '.' })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/renders as a\s+folder tree/i))
            .toBeInTheDocument()
    })

    it('reports a failure to read storage instead of rendering an empty tab', async () => {
        getPropertyStorage.mockRejectedValue(new Error('provider unreachable'))
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/Couldn't read this source's property storage/i))
            .toBeInTheDocument()
        expect(screen.getByText('provider unreachable')).toBeInTheDocument()
    })
})
