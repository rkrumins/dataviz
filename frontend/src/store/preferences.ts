import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface NodeStyleConfig {
  color: string
  icon?: string
  shape: 'rectangle' | 'rounded' | 'diamond' | 'hexagon'
  sizeMultiplier: number
}

export interface ShortcutConfig {
  id: string
  label: string
  keys: string
  action: string
}

interface PreferencesState {
  // Theme
  theme: ThemeMode
  accentColor: string
  setTheme: (theme: ThemeMode) => void
  setAccentColor: (color: string) => void

  // Node Styling
  nodeStyles: Record<string, NodeStyleConfig>
  setNodeStyle: (nodeType: string, config: Partial<NodeStyleConfig>) => void

  // Keyboard Shortcuts
  shortcuts: ShortcutConfig[]
  updateShortcut: (id: string, keys: string) => void
  resetShortcuts: () => void

  // Sidebar
  sidebarCollapsed: boolean
  toggleSidebar: () => void

  // Canvas preferences
  showMinimap: boolean
  showGrid: boolean
  snapToGrid: boolean
  toggleMinimap: () => void
  toggleGrid: () => void
  toggleSnapToGrid: () => void

  // LOD preferences
  autoLOD: boolean
  setAutoLOD: (enabled: boolean) => void
  toggleAutoLOD: () => void

  // Pinned views (sidebar quick access)
  pinnedViewIds: string[]
  pinView: (viewId: string) => void
  unpinView: (viewId: string) => void
  reorderPins: (viewIds: string[]) => void
}

const DEFAULT_SHORTCUTS: ShortcutConfig[] = [
  { id: 'command-palette', label: 'Command Palette', keys: 'mod+k', action: 'openCommandPalette' },
  { id: 'toggle-persona', label: 'Toggle Persona', keys: 'mod+/', action: 'togglePersona' },
  { id: 'save-view', label: 'Save Current View', keys: 'mod+s', action: 'saveView' },
  { id: 'focus-search', label: 'Focus Search', keys: 'mod+f', action: 'focusSearch' },
  { id: 'deselect', label: 'Deselect All', keys: 'escape', action: 'deselectAll' },
  { id: 'zoom-domains', label: 'Zoom to Domains', keys: 'mod+1', action: 'zoomToDomains' },
  { id: 'zoom-apps', label: 'Zoom to Apps', keys: 'mod+2', action: 'zoomToApps' },
  { id: 'zoom-assets', label: 'Zoom to Assets', keys: 'mod+3', action: 'zoomToAssets' },
  { id: 'fit-view', label: 'Fit to View', keys: 'mod+0', action: 'fitView' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', keys: 'mod+b', action: 'toggleSidebar' },
]

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      // Theme
      theme: 'system',
      accentColor: '#6366f1',
      setTheme: (theme) => set({ theme }),
      setAccentColor: (accentColor) => set({ accentColor }),

      // Node Styling — now driven by ontology definitions; empty defaults here.
      nodeStyles: {},
      setNodeStyle: (nodeType, config) => set((state) => ({
        nodeStyles: {
          ...state.nodeStyles,
          [nodeType]: { ...state.nodeStyles[nodeType], ...config },
        },
      })),

      // Shortcuts
      shortcuts: DEFAULT_SHORTCUTS,
      updateShortcut: (id, keys) => set((state) => ({
        shortcuts: state.shortcuts.map((s) =>
          s.id === id ? { ...s, keys } : s
        ),
      })),
      resetShortcuts: () => set({ shortcuts: DEFAULT_SHORTCUTS }),

      // Sidebar
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      // Canvas
      showMinimap: true,
      showGrid: true,
      snapToGrid: false,
      toggleMinimap: () => set((state) => ({ showMinimap: !state.showMinimap })),
      toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
      toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),

      // LOD
      autoLOD: false, // Off by default - user can enable
      setAutoLOD: (autoLOD) => set({ autoLOD }),
      toggleAutoLOD: () => set((state) => ({ autoLOD: !state.autoLOD })),

      // Pinned views
      pinnedViewIds: [],
      pinView: (viewId) => set((state) => {
        if (state.pinnedViewIds.includes(viewId)) return state
        if (state.pinnedViewIds.length >= 10) return state
        return { pinnedViewIds: [...state.pinnedViewIds, viewId] }
      }),
      unpinView: (viewId) => set((state) => ({
        pinnedViewIds: state.pinnedViewIds.filter(id => id !== viewId),
      })),
      reorderPins: (viewIds) => set({ pinnedViewIds: viewIds }),
    }),
    {
      name: 'nexus-preferences',
    }
  )
)

