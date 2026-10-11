/**
 * A session that must change its password goes straight to the change
 * screen, and the shell doesn't start loading data the API would refuse on
 * the way there. A session signed in through SSO doesn't, even while the
 * account's own password is pending a change.
 *
 * Everything the shell renders around the outlet is stubbed: this is
 * about the guard, not the chrome.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listViews = vi.fn(async () => ({ items: [] }))

vi.mock('../TopBar', () => ({ TopBar: () => null }))
vi.mock('../SidebarNav', () => ({ SidebarNav: () => null }))
vi.mock('../GlobalAnnouncementBanner', () => ({ GlobalAnnouncementBanner: () => null }))
vi.mock('../CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/help/HelpPanel', () => ({ HelpPanel: () => null }))
vi.mock('@/components/views/ViewWizard', () => ({ ViewWizard: () => null }))
vi.mock('@/components/ui/notifications', () => ({ NotificationStack: () => null }))
vi.mock('@/components/auth/AccessDeniedModal', () => ({ AccessDeniedModal: () => null }))
vi.mock('@/features/tour/TourOverlay', () => ({ TourOverlay: () => null }))
vi.mock('@/features/tour/TourLauncher', () => ({ TourLauncher: () => null }))
vi.mock('@/features/tour/useTourDeepLink', () => ({ useTourDeepLink: () => {} }))
vi.mock('@/hooks/useInviteWelcome', () => ({ useInviteWelcome: () => {} }))
vi.mock('@/hooks/useBackendRecovery', () => ({ useBackendRecovery: () => {} }))
vi.mock('@/hooks/useAppliedTheme', () => ({ useAppliedTheme: () => {} }))
vi.mock('@/services/viewApiService', () => ({
    listViews: () => listViews(),
    viewToViewConfig: (v: unknown) => v,
}))

import { AppLayout } from '../AppLayout'
import { useAuthStore } from '@/store/auth'

function signIn(passwordChangeRequired: boolean, mustChangePassword = passwordChangeRequired) {
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        user: {
            id: 'usr_1', email: 'a@b.c', firstName: 'A', lastName: 'B',
            role: 'super_admin', status: 'active', authProvider: 'local',
            createdAt: '', updatedAt: '', mustChangePassword, passwordChangeRequired,
        },
    } as never)
}

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/" element={<AppLayout />}>
                    <Route path="dashboard" element={<div>Dashboard</div>} />
                </Route>
                <Route path="/password-change-required" element={<div>Change screen</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => listViews.mockClear())

describe('AppLayout and a pending password change', () => {
    it('sends the account to the change screen and loads nothing', async () => {
        signIn(true)
        renderAt('/dashboard')
        expect(await screen.findByText('Change screen')).toBeInTheDocument()
        expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
        expect(listViews).not.toHaveBeenCalled()
    })

    it('lets everyone else through', async () => {
        signIn(false)
        renderAt('/dashboard')
        expect(await screen.findByText('Dashboard')).toBeInTheDocument()
        expect(listViews).toHaveBeenCalledTimes(1)
    })

    it('lets an SSO session through while the account password is pending', async () => {
        signIn(false, true)
        renderAt('/dashboard')
        expect(await screen.findByText('Dashboard')).toBeInTheDocument()
        expect(listViews).toHaveBeenCalledTimes(1)
    })
})
