/**
 * PropertyInsightsHeader — renders the four stat tiles (entity total from a
 * mocked catalogue-overview hook; the rest from props) plus guidance chips.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
                warnings={['2 types store properties in a container']}
            />,
        )
        expect(screen.getByText('128')).toBeInTheDocument()   // entities
        expect(screen.getByText('11')).toBeInTheDocument()    // properties
        expect(screen.getByText('3')).toBeInTheDocument()     // tags
        expect(screen.getByText('5')).toBeInTheDocument()     // types
        expect(screen.getByText(/store properties in a container/i))
            .toBeInTheDocument()
    })

    it('renders a warning that carries an href as a link to the fix', () => {
        render(
            <MemoryRouter>
                <PropertyInsightsHeader
                    viewId="v1"
                    propertyCount={1}
                    tagCount={0}
                    entityTypeCount={1}
                    warnings={[{
                        text: '2 types store properties in a container',
                        href: '/workspaces/ws_1?ds=ds_1&dsTab=mapping',
                    }]}
                />
            </MemoryRouter>,
        )
        // A warning that names a problem and offers no way to reach the fix
        // is a dead end — that was the whole reason for widening the type.
        expect(screen.getByRole('link', { name: /store properties in a container/i }))
            .toHaveAttribute('href', '/workspaces/ws_1?ds=ds_1&dsTab=mapping')
    })

    it('still accepts a plain string warning', () => {
        render(
            <PropertyInsightsHeader
                viewId="v1" propertyCount={1} tagCount={0} entityTypeCount={1}
                warnings={['No containment edges — hierarchy insights limited']}
            />,
        )
        expect(screen.getByText(/No containment edges/i)).toBeInTheDocument()
        expect(screen.queryByRole('link')).toBeNull()
    })
})
