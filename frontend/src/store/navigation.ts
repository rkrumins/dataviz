import { create } from 'zustand'

export type NavigationTab = 'dashboard' | 'explore' | 'lenses' | 'schema'

interface NavigationState {
    activeTab: NavigationTab
    setActiveTab: (tab: NavigationTab) => void
}

export const useNavigationStore = create<NavigationState>((set) => ({
    activeTab: 'dashboard',
    setActiveTab: (tab) => set({ activeTab: tab }),
}))
