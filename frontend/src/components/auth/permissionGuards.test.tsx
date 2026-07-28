/**
 * Route guards must not answer a question they haven't heard yet.
 *
 * ``status`` flips to 'authenticated' from the sessionStorage user cache
 * before any permission claim has been fetched — deliberately, so the
 * shell paints on reload (see store/userCache.ts). But the guards
 * derived "allowed" from the claims slice alone, and an un-hydrated
 * claim set is byte-for-byte a claim set that grants nothing. So every
 * gated route rendered "You don't have access" for the length of one
 * network round trip, at users who have perfectly good access.
 *
 * The bar: while the answer is outstanding, no denial anywhere. Once it
 * lands, a genuinely empty claim set must still deny — a user who really
 * holds nothing is a real state, not a broken one.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { RequirePermission, RequireWorkspacePermission } from './RequirePermission'
import { RequireNav } from './RequireNav'
import { RequireFeature } from '@/components/RequireFeature'
import { useAuthStore, type PermissionsStatus } from '@/store/auth'
import { useFeaturesStore } from '@/store/features'

const EMPTY = { sid: '', global: [], ws: {} }
const DENIED = /you don't have access/i

function claims(status: PermissionsStatus, global: string[] = []) {
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        permissions: { sid: 's1', global, ws: {} },
        permissionsStatus: status,
    })
}

beforeEach(() => {
    useAuthStore.setState({
        status: 'idle',
        isAuthenticated: false,
        user: null,
        permissions: EMPTY,
        permissionsStatus: 'unknown',
        error: null,
        isLoading: false,
    })
})


describe('RequirePermission', () => {
    it('renders no denial while the claims are still loading', () => {
        claims('loading')
        render(
            <RequirePermission perm="system:admin">
                <div>secret</div>
            </RequirePermission>,
        )

        expect(screen.queryByText(DENIED)).not.toBeInTheDocument()
        expect(screen.queryByText('secret')).not.toBeInTheDocument()
    })

    it('renders no denial while the claims are unknown', () => {
        // 'unknown' is the pre-hydrate state a cached-user boot passes
        // through. It is no more an answer than 'loading' is.
        claims('unknown')
        render(
            <RequirePermission perm="system:admin">
                <div>secret</div>
            </RequirePermission>,
        )

        expect(screen.queryByText(DENIED)).not.toBeInTheDocument()
    })

    it('denies once an empty claim set is the confirmed answer', () => {
        claims('ready')
        render(
            <RequirePermission perm="system:admin">
                <div>secret</div>
            </RequirePermission>,
        )

        expect(screen.getByText(DENIED)).toBeInTheDocument()
    })

    it('renders the children when the permission lands', () => {
        claims('ready', ['system:admin'])
        render(
            <RequirePermission perm="system:admin">
                <div>secret</div>
            </RequirePermission>,
        )

        expect(screen.getByText('secret')).toBeInTheDocument()
    })

    it('waits on the workspace-scoped variant too', () => {
        claims('loading')
        const { rerender } = render(
            <RequireWorkspacePermission ws="ws_1" perm="workspace:admin">
                <div>secret</div>
            </RequireWorkspacePermission>,
        )
        expect(screen.queryByText(DENIED)).not.toBeInTheDocument()

        claims('ready')
        rerender(
            <RequireWorkspacePermission ws="ws_1" perm="workspace:admin">
                <div>secret</div>
            </RequireWorkspacePermission>,
        )
        expect(screen.getByText(DENIED)).toBeInTheDocument()
    })
})


describe('RequireNav', () => {
    const guard = (
        <RequireNav group="admin" sectionKey="groups">
            <div>groups admin</div>
        </RequireNav>
    )

    it('renders no denial while the claims are still loading', () => {
        claims('loading')
        render(guard)

        expect(screen.queryByText(DENIED)).not.toBeInTheDocument()
        expect(screen.queryByText('groups admin')).not.toBeInTheDocument()
    })

    it('denies once an empty claim set is the confirmed answer', () => {
        claims('ready')
        render(guard)

        expect(screen.getByText(DENIED)).toBeInTheDocument()
    })

    it('renders the children when the permission lands', () => {
        claims('ready', ['system:groups:manage'])
        render(guard)

        expect(screen.getByText('groups admin')).toBeInTheDocument()
    })
})


describe('RequireFeature', () => {
    // Needs no permission state at all: the features store has always
    // tracked whether the served values arrived — the guard just never
    // asked, and redirected on the compile-time seed instead.
    function renderGuard() {
        return render(
            <MemoryRouter initialEntries={['/tours']}>
                <Routes>
                    <Route
                        path="/tours"
                        element={
                            <RequireFeature feature="toursEnabled">
                                <div>tour</div>
                            </RequireFeature>
                        }
                    />
                    <Route path="/" element={<div>redirected home</div>} />
                </Routes>
            </MemoryRouter>,
        )
    }

    beforeEach(() => {
        useFeaturesStore.setState({ values: { toursEnabled: false }, loaded: false })
    })

    it('does not commit a redirect before the served values arrive', () => {
        renderGuard()

        expect(screen.queryByText('redirected home')).not.toBeInTheDocument()
        expect(screen.queryByText('tour')).not.toBeInTheDocument()
    })

    it('redirects once the flag is confirmed off', () => {
        useFeaturesStore.setState({ values: { toursEnabled: false }, loaded: true })
        renderGuard()

        expect(screen.getByText('redirected home')).toBeInTheDocument()
    })

    it('renders the feature when the served values turn it on', () => {
        useFeaturesStore.setState({ values: { toursEnabled: true }, loaded: true })
        renderGuard()

        expect(screen.getByText('tour')).toBeInTheDocument()
    })
})

// ── RequireFeature: the explain branch is the live one ───────────────

describe('RequireFeature explain branch', () => {
    it('does not claim a feature is off before the flags have loaded', () => {
        useFeaturesStore.setState({ loaded: false, flags: {} })
        render(
            <MemoryRouter>
                <RequireFeature feature="reviewsEnabled" explain>
                    <div>reviews</div>
                </RequireFeature>
            </MemoryRouter>,
        )
        // Flags start seeded from bundled defaults plus a localStorage
        // cache. Announcing "turned off" off that guess is the same
        // flash as the permission panel, and this is the branch the
        // shipping call site actually takes.
        expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument()
    })

    it('explains once the flags say the feature really is off', () => {
        useFeaturesStore.setState({ loaded: true, flags: { reviewsEnabled: false } })
        render(
            <MemoryRouter>
                <RequireFeature feature="reviewsEnabled" explain>
                    <div>reviews</div>
                </RequireFeature>
            </MemoryRouter>,
        )
        expect(screen.getByText(/turned off/i)).toBeInTheDocument()
    })
})
