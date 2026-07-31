import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type {
    PropertyPreview,
    StorageEnvelope,
} from '@/services/propertyStorageService'

const getPropertyStorage = vi.fn()
const previewPropertyMapping = vi.fn()
const savePropertyMapping = vi.fn()
const rescanPropertyStorage = vi.fn()
const alignProperties = vi.fn()

vi.mock('@/services/propertyStorageService', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/propertyStorageService')
    >('@/services/propertyStorageService')
    return {
        ...actual,
        getPropertyStorage: (...a: unknown[]) => getPropertyStorage(...a),
        previewPropertyMapping: (...a: unknown[]) => previewPropertyMapping(...a),
        savePropertyMapping: (...a: unknown[]) => savePropertyMapping(...a),
        rescanPropertyStorage: (...a: unknown[]) => rescanPropertyStorage(...a),
        alignProperties: (...a: unknown[]) => alignProperties(...a),
    }
})

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ showToast: vi.fn() }),
}))

import { PropertyMappingTab } from '../PropertyMappingTab'

const CONTAINER_ENVELOPE: StorageEnvelope = {
    meta: { status: 'fresh', age_seconds: 120 },
    data: {
        containerKey: 'properties',
        separator: '/',
        collectUnmapped: true,
        propertyOverrides: {},
        labels: {
            dataset: {
                sampled: 200,
                containerSampled: 200,
                labelTotal: 12043,
                storage: 'container',
                nativeKeys: [],
                containerKeys: ['properties'],
                inferredPaths: ['technical/format', 'technical/owner'],
                affectedEstimate: 12043,
                unparseable: 0,
                collisions: [
                    { field: 'level', samples: ['tier-1'], suggested: 'source/level' },
                ],
            },
        },
        totals: {
            labels: 1,
            affectedEstimate: 12043,
            newPaths: 2,
            needsAlignment: ['dataset'],
        },
        samplePerLabel: 200,
        sizedFromCache: true,
        elapsedMs: 12,
    },
}

const PREVIEW: PropertyPreview = {
    count: 1,
    samples: [{
        urn: 'urn:x',
        label: 'dataset',
        displayName: 'Revenue',
        before: { properties: '{"technical":{"format":"parquet"}}' },
        after: { 'technical/format': 'parquet' },
        newlySearchable: ['technical/format'],
    }],
}

beforeEach(() => {
    vi.clearAllMocks()
    getPropertyStorage.mockResolvedValue(CONTAINER_ENVELOPE)
    previewPropertyMapping.mockResolvedValue(PREVIEW)
    savePropertyMapping.mockResolvedValue({})
    rescanPropertyStorage.mockResolvedValue({ jobId: 'j1' })
    alignProperties.mockResolvedValue({ jobId: 'j2', status: 'pending', dryRun: false })
})

describe('PropertyMappingTab', () => {
    it('leads with how many nodes are affected and why it matters', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/12,043 nodes.*store properties in a container/i))
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

        expect(screen.getByText(/1 become searchable/)).toBeInTheDocument()
    })

    it('promises no gain when the mapping changes nothing', async () => {
        previewPropertyMapping.mockResolvedValue({
            count: 1,
            samples: [{
                urn: 'urn:x', label: 'dataset', displayName: 'Revenue',
                before: { owner: 'team' },
                after: { owner: 'team' },
                newlySearchable: [],
            }],
        })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText('Now')).toBeInTheDocument()
        expect(screen.queryByText(/become searchable/)).toBeNull()
    })

    it('says nothing needs doing when every label is already native', async () => {
        getPropertyStorage.mockResolvedValue({
            meta: { status: 'fresh', age_seconds: 60 },
            data: {
                ...CONTAINER_ENVELOPE.data!,
                labels: {
                    dataset: {
                        ...CONTAINER_ENVELOPE.data!.labels.dataset,
                        storage: 'native', containerSampled: 0,
                        affectedEstimate: 0, collisions: [],
                    },
                },
                totals: {
                    labels: 1, affectedEstimate: 0, newPaths: 0,
                    needsAlignment: [],
                },
            },
        })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/Every property is a native field/i))
            .toBeInTheDocument()
        // …and nothing invites a rewrite that would do nothing.
        expect(screen.queryByRole('button', { name: /Align properties/ })).toBeNull()
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
        getPropertyStorage.mockResolvedValue({
            ...CONTAINER_ENVELOPE,
            data: { ...CONTAINER_ENVELOPE.data!, separator: '.' },
        })
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

    // ── Cache-served states ──────────────────────────────────────────

    it('shows where the report came from, and offers a re-scan', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        // Provenance is first-class here: the report is profiled out-of-band,
        // so "how old is this" is part of reading it correctly.
        expect(await screen.findByText(/from cached profile/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Re-scan/ })).toBeInTheDocument()
    })

    it('queues a re-scan on demand', async () => {
        const user = userEvent.setup()
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        await user.click(await screen.findByRole('button', { name: /Re-scan/ }))
        await waitFor(() => expect(rescanPropertyStorage).toHaveBeenCalledWith('ws_1', 'ds_1'))
    })

    it('explains itself while the first profile is still computing', async () => {
        getPropertyStorage.mockResolvedValue({
            data: null, meta: { status: 'computing', age_seconds: null, job_id: 'j' },
        })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/Profiling this source/i)).toBeInTheDocument()
        // The reason it isn't just slow: a large graph is never scanned inline.
        expect(screen.getByText(/never scanned while you wait/i)).toBeInTheDocument()
    })

    it('qualifies the numbers as estimates from a sample', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)
        expect(await screen.findByText(/estimated from a 200-node sample/i))
            .toBeInTheDocument()
    })

    it('says so when totals are not cached rather than implying zero', async () => {
        getPropertyStorage.mockResolvedValue({
            meta: { status: 'fresh', age_seconds: 30 },
            data: {
                ...CONTAINER_ENVELOPE.data!,
                sizedFromCache: false,
                labels: {
                    dataset: {
                        ...CONTAINER_ENVELOPE.data!.labels.dataset,
                        labelTotal: null, affectedEstimate: null,
                    },
                },
                totals: {
                    labels: 1, affectedEstimate: null, newPaths: 2,
                    needsAlignment: ['dataset'],
                },
            },
        })
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        expect(await screen.findByText(/only the proportions are/i)).toBeInTheDocument()
        expect(screen.getByText(/Some nodes store properties in a container/i))
            .toBeInTheDocument()
    })

    // ── The align action ─────────────────────────────────────────────

    it('offers the durable fix, and starts it', async () => {
        const user = userEvent.setup()
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        await user.click(await screen.findByRole('button', { name: /Align properties/ }))
        await waitFor(() => expect(alignProperties).toHaveBeenCalledWith('ds_1'))
    })

    it('blocks aligning against an unsaved mapping', async () => {
        const user = userEvent.setup()
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit />)

        await screen.findByText('dataset')
        await user.click(screen.getByRole('button', { name: /Keep as source\/level/ }))

        // Running against the saved mapping while the editor shows another one
        // would rewrite the graph to something the operator never previewed.
        expect(await screen.findByRole('button', { name: /Align properties/ }))
            .toBeDisabled()
    })

    it('offers no write actions without manage permission', async () => {
        render(<PropertyMappingTab wsId="ws_1" dataSourceId="ds_1" canEdit={false} />)

        await screen.findByText('dataset')
        expect(screen.queryByRole('button', { name: /Align properties/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Save Mapping/ })).toBeNull()
    })
})
