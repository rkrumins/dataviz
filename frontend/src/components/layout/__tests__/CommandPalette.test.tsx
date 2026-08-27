/**
 * The app-wide command palette.
 *
 * Three things it got wrong, pinned here: it offered "Open Settings" and
 * went nowhere, it showed the same fixed command rows under every query
 * (search "orders", get offered "Toggle Theme"), and it could reach two
 * of the product's pages by name. The header button above it advertised
 * "Search nodes in <view>" on a canvas — a thing this palette has never
 * been able to do.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/store/auth'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigate }
})

// The palette's entity search is a different unit (useGlobalSearch, which
// hits the views API). These specs are about pages and commands.
vi.mock('@/hooks/useGlobalSearch', async () => {
    const actual = await vi.importActual<typeof import('@/hooks/useGlobalSearch')>(
        '@/hooks/useGlobalSearch',
    )
    return {
        ...actual,
        useGlobalSearch: () => ({
            query: '',
            isLoading: false,
            byCategory: {
                Workspace: [], 'Data Source': [], View: [],
                Template: [], 'Semantic Layer': [],
            },
            totalByCategory: {
                Workspace: 0, 'Data Source': 0, View: 0,
                Template: 0, 'Semantic Layer': 0,
            },
        }),
    }
})

import { CommandPalette } from '../CommandPalette'


function renderPalette(route = '/dashboard') {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[route]}>
                <CommandPalette open onOpenChange={vi.fn()} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

function type(query: string) {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: query } })
}

const list = () => screen.getByRole('listbox')


describe('CommandPalette — what it says it searches', () => {
    beforeEach(() => {
        navigate.mockClear()
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: {} } })
    })

    it('names its scope instead of leaving the user to guess', () => {
        renderPalette()
        expect(screen.getByText(/Workspaces, views, data sources, and pages/i))
            .toBeInTheDocument()
    })

    it('on a canvas, points at the search that does cover the data', () => {
        renderPalette('/views/abc')
        expect(screen.getByText(/search the data inside this view/i))
            .toBeInTheDocument()
    })

    it('says nothing about in-view search anywhere else', () => {
        renderPalette('/dashboard')
        expect(screen.queryByText(/search the data inside this view/i)).toBeNull()
    })
})


describe('CommandPalette — pages are findable by name', () => {
    beforeEach(() => {
        navigate.mockClear()
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: {} } })
    })

    it('finds a settings page and opens it', () => {
        renderPalette()
        type('account')
        fireEvent.click(within(list()).getByText('Account Settings'))
        expect(navigate).toHaveBeenCalledWith('/me/account')
    })

    it('withholds admin pages from a user who could not open them', () => {
        renderPalette()
        type('audit')
        expect(within(list()).queryByText('Audit Log')).toBeNull()
    })

    it('offers them once the claim is there', () => {
        useAuthStore.setState({
            permissions: { sid: 't', global: ['system:audit:read'], ws: {} },
        })
        renderPalette()
        type('audit')
        expect(within(list()).getByText('Audit Log')).toBeInTheDocument()
    })
})


describe('CommandPalette — the fixed rows stop shouting', () => {
    beforeEach(() => {
        navigate.mockClear()
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: {} } })
    })

    it('does not offer "Toggle Theme" to someone searching for data', () => {
        renderPalette()
        type('orders')
        expect(within(list()).queryByText('Toggle Theme')).toBeNull()
    })

    it('still offers it when that is what was typed', () => {
        renderPalette()
        type('theme')
        expect(within(list()).getByText('Toggle Theme')).toBeInTheDocument()
    })

    it('shows the full set of shortcuts with an empty box', () => {
        renderPalette()
        expect(within(list()).getByText('Go to Dashboard')).toBeInTheDocument()
        expect(within(list()).getByText('Toggle Theme')).toBeInTheDocument()
    })

    it('"Open Settings" actually opens settings', () => {
        // It used to dispatch an action with no matching case: the row
        // closed the palette and went nowhere.
        renderPalette()
        fireEvent.click(within(list()).getByText('Open Settings'))
        expect(navigate).toHaveBeenCalledWith('/me/account')
    })
})
