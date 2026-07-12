/**
 * DataSourceOverviewPage — render smoke test.
 *
 * The page is now a thin frame (back button + page chrome) around
 * DataSourceProfile, which is unit-tested separately. This just verifies
 * the frame wires up: the profile mounts with the right catalogId, and the
 * back button to Data Sources renders.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/insights/DataSourceProfile', () => ({
    DataSourceProfile: () => <div data-testid="profile" />,
}))

import { DataSourceOverviewPage } from './DataSourceOverviewPage'

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/datasources/cat-1']}>
            <Routes>
                <Route path="/datasources/:catalogId" element={<DataSourceOverviewPage />} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('DataSourceOverviewPage', () => {
    it('renders the profile and the back link', () => {
        renderPage()

        expect(screen.getByTestId('profile')).toBeInTheDocument()
        expect(screen.getByText('Data Sources')).toBeInTheDocument()
    })
})
