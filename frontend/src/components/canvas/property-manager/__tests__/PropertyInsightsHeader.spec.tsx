/**
 * PropertyInsightsHeader — renders the four stat tiles (entity total from a
 * mocked catalogue-overview hook; the rest from props) plus guidance chips.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { PropertyInsightsHeader } from '../PropertyInsightsHeader'


vi.mock('@/hooks/usePropertyInsights', () => ({
    useCatalogOverview: () => ({
        data: { totalEntities: 128, byEntityType: [] },
        loading: false,
        error: null,
    }),
}))


describe('PropertyInsightsHeader', () => {
    it('shows entity total + catalogue counts + a warning chip', () => {
        render(
            <PropertyInsightsHeader
                viewId="v1"
                propertyCount={11}
                tagCount={3}
                entityTypeCount={5}
                warnings={['2 types not yet migrated — limited analytics']}
            />,
        )
        expect(screen.getByText('128')).toBeInTheDocument()   // entities
        expect(screen.getByText('11')).toBeInTheDocument()    // properties
        expect(screen.getByText('3')).toBeInTheDocument()     // tags
        expect(screen.getByText('5')).toBeInTheDocument()     // types
        expect(screen.getByText(/not yet migrated/i)).toBeInTheDocument()
    })
})
