/**
 * Help drawer store — controls the in-app slide-over Help panel.
 *
 * Non-persisted (session-only) like the branding store: the drawer's
 * open/closed state should never survive a reload. Components subscribe with
 * selectors (`useHelpPanelStore(s => s.open)`); imperative openers (TopBar
 * button, the `?` shortcut) call `useHelpPanelStore.getState()` so they don't
 * need the store wired through props.
 */
import { create } from 'zustand'

/** Which view the drawer should land on when it opens. Reset to 'home' on close. */
export type HelpIntent = 'home' | 'getting-started'

interface HelpPanelState {
    open: boolean
    /** Read once by the panel when it opens to pick its initial view. */
    intent: HelpIntent
    openHelp: () => void
    /** Open straight to the Getting Started hub (sidebar launcher). */
    openGettingStarted: () => void
    closeHelp: () => void
    toggleHelp: () => void
}

export const useHelpPanelStore = create<HelpPanelState>()((set) => ({
    open: false,
    intent: 'home',
    openHelp: () => set({ open: true, intent: 'home' }),
    openGettingStarted: () => set({ open: true, intent: 'getting-started' }),
    closeHelp: () => set({ open: false, intent: 'home' }),
    toggleHelp: () => set((s) => ({ open: !s.open, intent: 'home' })),
}))
