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

interface HelpPanelState {
    open: boolean
    openHelp: () => void
    closeHelp: () => void
    toggleHelp: () => void
}

export const useHelpPanelStore = create<HelpPanelState>()((set) => ({
    open: false,
    openHelp: () => set({ open: true }),
    closeHelp: () => set({ open: false }),
    toggleHelp: () => set((s) => ({ open: !s.open })),
}))
