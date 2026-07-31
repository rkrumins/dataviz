/**
 * PropertyShapeField — the onboarding-time half of the feature.
 *
 * The whole point is that a user who doesn't know they have this problem finds
 * out at the moment they can still fix it cheaply. So the behaviour under test
 * is: does it detect, does it unfold itself, and does it stay quiet otherwise.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'

const discoverSchema = vi.fn()
vi.mock('@/services/providerService', () => ({
    providerService: { discoverSchema: (...a: unknown[]) => discoverSchema(...a) },
}))

import { PropertyShapeField } from '../PropertyShapeField'
import {
    DEFAULT_PROPERTY_MAPPING,
    type PropertyMapping,
} from '@/services/propertyStorageService'

function Harness({ onChange }: { onChange?: (m: PropertyMapping) => void }) {
    const [value, setValue] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    return (
        <PropertyShapeField
            value={value}
            onChange={m => { setValue(m); onChange?.(m) }}
            providerId="prov_1"
            graphName="warehouse"
        />
    )
}

function renderField(onChange?: (m: PropertyMapping) => void) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}><Harness onChange={onChange} /></QueryClientProvider>,
    )
}

/** A graph that stores everything under `attributes`, as a JSON string —
 *  FalkorDB has no map type, so this is what a foreign writer actually lands. */
const NESTED_SCHEMA = {
    labels: ['dataset'],
    relationshipTypes: [],
    labelDetails: {
        dataset: {
            count: 100,
            propertyKeys: ['urn', 'attributes'],
            samples: [{ urn: 'urn:x', attributes: '{"technical":{"format":"parquet"}}' }],
        },
    },
}

const FLAT_SCHEMA = {
    labels: ['dataset'],
    relationshipTypes: [],
    labelDetails: {
        dataset: {
            count: 100,
            propertyKeys: ['urn', 'format'],
            samples: [{ urn: 'urn:x', format: 'parquet' }],
        },
    },
}

beforeEach(() => vi.clearAllMocks())

describe('PropertyShapeField', () => {
    it('detects nesting by shape and opens itself', async () => {
        discoverSchema.mockResolvedValue(NESTED_SCHEMA)
        renderField()

        // Detection is by value shape, not by key name — which is why it finds
        // `attributes` rather than only the conventional `properties`.
        expect(await screen.findByText('attributes')).toBeInTheDocument()
        // Unfolded without being asked: the form is visible, not just the header.
        expect(screen.getByLabelText('Property container key')).toBeInTheDocument()
    })

    it('seeds the container key from what the graph really uses', async () => {
        discoverSchema.mockResolvedValue(NESTED_SCHEMA)
        const onChange = vi.fn()
        renderField(onChange)

        await screen.findByText('attributes')
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ containerKey: 'attributes' }),
        )
    })

    it('stays folded and says so when the graph is already flat', async () => {
        discoverSchema.mockResolvedValue(FLAT_SCHEMA)
        renderField()

        expect(await screen.findByText(/Already flat/i)).toBeInTheDocument()
        expect(screen.queryByLabelText('Property container key')).toBeNull()
    })

    it('opens on request even when nothing was detected', async () => {
        const user = userEvent.setup()
        discoverSchema.mockResolvedValue(FLAT_SCHEMA)
        renderField()

        await user.click(await screen.findByText('Property shape'))

        // The probe samples; a source can nest in a corner the sample missed,
        // so the control must never be unreachable.
        expect(screen.getByText(/Nothing nested turned up/i)).toBeInTheDocument()
        expect(screen.getByLabelText('Property container key')).toBeInTheDocument()
    })

    it('degrades quietly when the probe fails', async () => {
        discoverSchema.mockRejectedValue(new Error('unreachable'))
        renderField()

        // Onboarding must not stall on an optional convenience.
        expect(await screen.findByText(/Already flat/i)).toBeInTheDocument()
    })
})
