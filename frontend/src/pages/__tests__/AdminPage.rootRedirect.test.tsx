/**
 * /admin picks a landing sub-page from the user's claims — and it
 * REDIRECTS to do it.
 *
 * That makes an un-hydrated claim set far more expensive here than in a
 * guard. With empty claims every section filters out, ``firstVisible``
 * falls back to 'overview', and the redirect fires: not a frame of the
 * wrong panel, but a committed route change. A delegated groups admin
 * landed permanently on /admin/overview — a page they cannot see —
 * with nothing to tell them /admin/groups was theirs all along.
 */
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminPage } from '../AdminPage'
import { useAuthStore, type PermissionsStatus } from '@/store/auth'

vi.mock('@/store/branding', () => ({
    useBrand: () => ({ appName: 'Test' }),
}))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

function setClaims(permissionsStatus: PermissionsStatus, global: string[] = []) {
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        permissions: { sid: 's1', global, ws: {} },
        permissionsStatus,
    })
}

function renderAtAdminRoot() {
    return render(
        <MemoryRouter initialEntries={['/admin']}>
            <Routes>
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/admin/overview" element={<div>overview page</div>} />
                <Route path="/admin/groups" element={<div>groups page</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    setClaims('unknown')
    useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} } })
})


describe('AdminPage root redirect', () => {
    it('does not navigate anywhere while the claims are still loading', () => {
        setClaims('loading')
        renderAtAdminRoot()

        expect(screen.queryByText('overview page')).not.toBeInTheDocument()
        expect(screen.queryByText('groups page')).not.toBeInTheDocument()
    })

    it('lands a delegated groups admin on /admin/groups once claims arrive', () => {
        setClaims('loading')
        renderAtAdminRoot()

        act(() => { setClaims('ready', ['system:groups:manage']) })

        expect(screen.getByText('groups page')).toBeInTheDocument()
        // The whole point: never the fallback they can't see.
        expect(screen.queryByText('overview page')).not.toBeInTheDocument()
    })

    it('still sends a full admin to /admin/overview', () => {
        setClaims('ready', ['system:admin'])
        renderAtAdminRoot()

        expect(screen.getByText('overview page')).toBeInTheDocument()
    })
})
