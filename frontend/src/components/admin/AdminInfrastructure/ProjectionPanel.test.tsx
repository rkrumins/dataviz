/**
 * The projection panel on Admin → Infrastructure counts each state, graphs being loaded and graphs
 * waiting for room among them, and links a system admin to every graph, in Admin → Versioned graphs.
 * (Ported from the inventory's suite, which moved with the inventory.)
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ProjectionPanel } from './ProjectionPanel'
import type { GraphProvider, ProjectionSection } from '@/services/systemStatusService'

const PROVIDERS: GraphProvider[] = [
    { id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true },
]

const PROJECTION: ProjectionSection = {
    totalGraphs: 3, fresh: 3, lagging: 0, projecting: 0, rebuilding: 0, evicted: 0, failed: 0, maxLag: 0, worst: [],
}

describe('ProjectionPanel', () => {
    it('links to every versioned graph, in Admin → Versioned graphs', () => {
        render(
            <MemoryRouter>
                <ProjectionPanel projection={PROJECTION} providers={PROVIDERS} linkAll />
            </MemoryRouter>,
        )
        expect(screen.getByRole('link', { name: 'All versioned graphs' })).toHaveAttribute('href', '/admin/versioned-graphs')
    })

    it('counts graphs being loaded and graphs waiting for room', () => {
        render(
            <MemoryRouter>
                <ProjectionPanel projection={{ ...PROJECTION, rehydrating: 2, waitingCapacity: 1 }} providers={PROVIDERS} />
            </MemoryRouter>,
        )
        const chip = (text: string) => (_: string, el: Element | null) => el?.textContent === text
        expect(screen.getByText(chip('2 loading'))).toBeInTheDocument()
        expect(screen.getByText(chip('1 waiting for room'))).toBeInTheDocument()
    })

    it('offers no link to someone who cannot open the list', () => {
        render(
            <MemoryRouter>
                <ProjectionPanel projection={PROJECTION} providers={PROVIDERS} />
            </MemoryRouter>,
        )
        expect(screen.queryByRole('link', { name: 'All versioned graphs' })).not.toBeInTheDocument()
    })
})
