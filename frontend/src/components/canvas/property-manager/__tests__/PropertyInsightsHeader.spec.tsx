/**
 * PropertyInsightsHeader — the four stat tiles, all from the view's exact
 * property catalog, and below them how the numbers were come by: a read
 * still running (its numbers are floors), or when the catalog was read,
 * whether the data has changed since, and a refresh.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'

import type { SearchCatalogResult } from '@/types/search'

import { PropertyInsightsHeader } from '../PropertyInsightsHeader'


function catalog(over: Partial<SearchCatalogResult> = {}): SearchCatalogResult {
    return {
        sessionId: 's', status: 'complete', stale: false, entities: 128,
        asOf: new Date(Date.now() - 5 * 60_000).toISOString(),
        entityTypes: Array.from({ length: 5 }, (_, i) => ({ type: `t${i}`, count: 1 })),
        properties: Array.from({ length: 11 }, (_, i) => ({
            key: `k${i}`, count: 1, distinct: 1, distinctExact: true,
            byEntityType: {}, kinds: {}, values: [], residual: 0,
        })),
        tags: Array.from({ length: 3 }, (_, i) => ({ tag: `g${i}`, count: 1 })),
        ...over,
    }
}


describe('PropertyInsightsHeader', () => {
    it('shows the exact entity, property, tag and type counts', () => {
        render(<PropertyInsightsHeader catalog={catalog()} reading={null} onRefresh={vi.fn()} />)
        expect(screen.getByText('128')).toBeInTheDocument()   // entities
        expect(screen.getByText('11')).toBeInTheDocument()    // properties
        expect(screen.getByText('3')).toBeInTheDocument()     // tags
        expect(screen.getByText('5')).toBeInTheDocument()     // types
        expect(screen.getByText(/Exact — every entity read/)).toBeInTheDocument()
    })

    it('reads its numbers as floors, with progress, while the first read runs', () => {
        render(
            <PropertyInsightsHeader
                catalog={catalog({ status: 'running' })} reading={34} onRefresh={vi.fn()} />,
        )
        expect(screen.getByText('≥128')).toBeInTheDocument()
        expect(screen.getByRole('progressbar', { name: 'Reading every entity in this view' }))
            .toHaveAttribute('aria-valuenow', '34')
        expect(screen.getByText(/Reading every entity in this view · 34%/)).toBeInTheDocument()
    })

    it('keeps the exact numbers while the view is read again', () => {
        render(<PropertyInsightsHeader catalog={catalog()} reading={12} onRefresh={vi.fn()} />)
        expect(screen.getByText('128')).toBeInTheDocument()
        expect(screen.getByText(/Reading the view again · 12%/)).toBeInTheDocument()
    })

    it('says when the data has changed since, and reads it again on request', async () => {
        const onRefresh = vi.fn()
        render(<PropertyInsightsHeader catalog={catalog({ stale: true })} reading={null} onRefresh={onRefresh} />)
        expect(screen.getByText(/the data has changed since/)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Read the view again' }))
        expect(onRefresh).toHaveBeenCalledTimes(1)
    })

    it('says a new read failed while showing the last one', () => {
        render(<PropertyInsightsHeader catalog={catalog()} reading={null} error="Service Unavailable"
            onRefresh={vi.fn()} />)
        expect(screen.getByText(/Couldn't read the view again — Service Unavailable/)).toBeInTheDocument()
    })
})
