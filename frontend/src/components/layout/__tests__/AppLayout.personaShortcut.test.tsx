/**
 * ⌘/ (Ctrl-/ off Apple) switches Business / Technical names from anywhere in the app — the
 * shortcut the command palette and the top bar's toggle advertise, and which for a long time
 * nothing listened for. It must not take the chord from a field (a code editor's ⌘/ comments a
 * line), answer the other platform's modifier, or flick back and forth while the key is held.
 *
 * Everything the shell renders around the outlet is stubbed: this is about the shortcut.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    listViews: async () => ({ items: [] }),
    viewToViewConfig: (v: unknown) => v,
}))

import { AppLayout } from '../AppLayout'
import { useAuthStore } from '@/store/auth'
import { usePersonaStore } from '@/store/persona'

const platform = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'platform')

async function renderShell() {
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        user: {
            id: 'usr_1', email: 'a@b.c', firstName: 'A', lastName: 'B',
            role: 'super_admin', status: 'active', authProvider: 'local',
            createdAt: '', updatedAt: '', mustChangePassword: false, passwordChangeRequired: false,
        },
    } as never)
    render(
        <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
                <Route path="/" element={<AppLayout />}>
                    <Route path="dashboard" element={<>
                        <input aria-label="a field" />
                        <div aria-label="an editor" contentEditable suppressContentEditableWarning />
                    </>} />
                </Route>
            </Routes>
        </MemoryRouter>,
    )
    await screen.findByLabelText('a field')
}

const mode = () => usePersonaStore.getState().mode
const slash = (init: KeyboardEventInit, target: Element = document.body) =>
    fireEvent.keyDown(target, { key: '/', ...init })

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    if (platform) Object.defineProperty(navigator, 'platform', { ...platform, configurable: true })
    else delete (navigator as { platform?: string }).platform
})

describe('⌘/ (Ctrl-/) switches Business / Technical names', () => {
    it('switches with Ctrl-/ off Apple, and back again', async () => {
        await renderShell()
        slash({ ctrlKey: true })
        expect(mode()).toBe('technical')
        slash({ ctrlKey: true })
        expect(mode()).toBe('business')
    })

    it('switches with ⌘/ on Apple, where Ctrl-/ is not the shortcut', async () => {
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
        await renderShell()
        slash({ ctrlKey: true })
        expect(mode()).toBe('business')
        slash({ metaKey: true })
        expect(mode()).toBe('technical')
    })

    it('leaves the chord to a field or an editor that has focus', async () => {
        await renderShell()
        const editor = screen.getByLabelText('an editor')
        // jsdom has no `isContentEditable`; a browser reports it for a contenteditable editor.
        Object.defineProperty(editor, 'isContentEditable', { value: true })
        slash({ ctrlKey: true }, screen.getByLabelText('a field'))
        expect(mode()).toBe('business')
        slash({ ctrlKey: true }, editor)
        expect(mode()).toBe('business')
    })

    it('switches once for a held key, and not for "/" alone or with Alt', async () => {
        await renderShell()
        slash({ ctrlKey: true })
        // An odd number of repeats: answering them would leave the other mode.
        for (let i = 0; i < 3; i++) slash({ ctrlKey: true, repeat: true })
        expect(mode()).toBe('technical')
        slash({})
        slash({ ctrlKey: true, altKey: true })
        expect(mode()).toBe('technical')
    })
})
