/**
 * The finding sits inside a panel whose other lines are graded verdicts. If it
 * renders nothing while loading or after a failure, a reader takes the panel's
 * silence for a pass — which is the one conclusion we can't support.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getPropertyStorage = vi.fn()

vi.mock('@/services/propertyStorageService', () => ({
    getPropertyStorage: (...a: unknown[]) => getPropertyStorage(...a),
}))

import { PropertyStorageFinding } from '../PropertyStorageFinding'

function renderFinding() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <PropertyStorageFinding wsId="ws_1" dataSourceId="ds_1" />
        </QueryClientProvider>,
    )
}

const NESTED = {
    meta: { status: 'fresh', age_seconds: 30 },
    data: {
        containerKey: 'properties', separator: '/', collectUnmapped: true,
        propertyOverrides: {}, labels: {},
        totals: {
            labels: 1, affectedEstimate: 12043, newPaths: 2,
            needsAlignment: ['dataset'],
        },
        samplePerLabel: 200, sizedFromCache: true, elapsedMs: 5,
    },
}

beforeEach(() => vi.clearAllMocks())

describe('PropertyStorageFinding', () => {
    it('says it is still checking rather than showing nothing', () => {
        getPropertyStorage.mockReturnValue(new Promise(() => {}))
        renderFinding()
        expect(screen.getByText(/Checking how properties are stored/i))
            .toBeInTheDocument()
    })

    it('reports a failed read as unknown, not as clear', async () => {
        getPropertyStorage.mockRejectedValue(new Error('nope'))
        renderFinding()
        expect(await screen.findByText(/unknown, not clear/i)).toBeInTheDocument()
    })

    it('names the affected types and offers the fix', async () => {
        getPropertyStorage.mockResolvedValue(NESTED)
        renderFinding()
        expect(await screen.findByText(/keep their\s+properties nested/i))
            .toBeInTheDocument()
        expect(screen.getByText(/12,043 nodes/)).toBeInTheDocument()
    })

    it('confirms an all-native source affirmatively', async () => {
        getPropertyStorage.mockResolvedValue({
            ...NESTED,
            data: { ...NESTED.data, totals: { ...NESTED.data.totals, needsAlignment: [] } },
        })
        renderFinding()
        expect(await screen.findByText(/Every property is a native field/i))
            .toBeInTheDocument()
    })
})
