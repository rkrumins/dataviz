import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'

/** Visual density of list/grid items in the Explorer page. */
export type ExplorerDensity = 'compact' | 'comfortable' | 'spacious'

/** Visual density of layer column tree items in the Context View canvas. */
export type CanvasDensity = 'compact' | 'comfortable' | 'spacious'

export const CANVAS_ZOOM_MIN = 0.75
export const CANVAS_ZOOM_MAX = 1.5
export const CANVAS_ZOOM_STEP = 0.05

/**
 * How lineage edges render on the canvas.
 *  - 'stubs'  : every node with lineage shows a small stub; real edges materialize on hover/click.
 *  - 'auto'   : nodes with ≤ a small fan-in render real edges directly; denser nodes show stubs.
 *  - 'raw'    : every fetched edge renders as a real edge (legacy behavior). Prompts at >5,000.
 */
export type LineageRenderMode = 'stubs' | 'auto' | 'raw'

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

  // Lineage rendering — controls stub vs raw edge rendering on the canvas.
  // Default 'stubs' so the canvas stays GPU-stable regardless of fetched volume.
  // Switching to 'raw' is the user's explicit opt-in to render everything.
  lineageRenderMode: LineageRenderMode
  setLineageRenderMode: (mode: LineageRenderMode) => void
  /** Threshold for 'auto' mode — a node with edgeCount ≤ this in a direction renders real edges instead of a stub. */
  lineageAutoThreshold: number
  setLineageAutoThreshold: (n: number) => void
  /**
   * Global edge-count threshold for `auto` mode. When the projected edge
   * count exceeds this, the canvas falls back to stub rendering even if
   * per-node fan-in is low. Distinct from `lineageAutoThreshold` (per-node).
   */
  autoStubThreshold: number
  setAutoStubThreshold: (n: number) => void
  /**
   * Browse-mode parent-pair fan-in threshold. Any collapsed-parent pair with
   * more than this many leaf edges between its descendants collapses into
   * one bundle. Default 1 — every multi-edge pair bundles immediately.
   * Raise to 2/3 to keep small pairs un-bundled while still collapsing hubs.
   */
  lineageBundleFanIn: number
  setLineageBundleFanIn: (n: number) => void

  // Pinned views (sidebar quick access)
  pinnedViewIds: string[]
  pinView: (viewId: string) => void
  unpinView: (viewId: string) => void
  reorderPins: (viewIds: string[]) => void

  // User avatar
  avatarId: string | null
  setAvatarId: (id: string | null) => void

  // Onboarding
  onboardingCompletedSteps: string[]
  onboardingDismissedAt: string | null
  completeOnboardingStep: (step: string) => void
  dismissOnboarding: () => void
  resetOnboarding: () => void

  // Explorer density (affects grid gaps + list row padding)
  explorerDensity: ExplorerDensity
  setExplorerDensity: (density: ExplorerDensity) => void

  // Context View display settings — control canvas-side rendering density,
  // zoom, and visual chrome from the header's Display Settings popover.
  canvasZoom: number
  setCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  setCanvasDensity: (density: CanvasDensity) => void
  showCanvasTypeBadge: boolean
  toggleCanvasTypeBadge: () => void
  subtleCanvasTreeLines: boolean
  toggleSubtleCanvasTreeLines: () => void
  resetCanvasDisplaySettings: () => void
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

      // Lineage rendering
      lineageRenderMode: 'stubs',
      setLineageRenderMode: (lineageRenderMode) => set({ lineageRenderMode }),
      lineageAutoThreshold: 5,
      setLineageAutoThreshold: (lineageAutoThreshold) => set({ lineageAutoThreshold }),
      autoStubThreshold: 500,
      setAutoStubThreshold: (autoStubThreshold) => set({ autoStubThreshold }),
      lineageBundleFanIn: 1,
      setLineageBundleFanIn: (lineageBundleFanIn) => set({ lineageBundleFanIn }),

      // User avatar
      avatarId: null,
      setAvatarId: (avatarId) => set({ avatarId }),

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

      // Onboarding
      onboardingCompletedSteps: [],
      onboardingDismissedAt: null,
      completeOnboardingStep: (step) => set((state) => {
        if (state.onboardingCompletedSteps.includes(step)) return state
        return { onboardingCompletedSteps: [...state.onboardingCompletedSteps, step] }
      }),
      dismissOnboarding: () => set({ onboardingDismissedAt: new Date().toISOString() }),
      resetOnboarding: () => set({ onboardingCompletedSteps: [], onboardingDismissedAt: null }),

      // Explorer density
      explorerDensity: 'comfortable',
      setExplorerDensity: (explorerDensity) => set({ explorerDensity }),

      // Context View display settings
      canvasZoom: 1,
      setCanvasZoom: (n) => set({
        canvasZoom: Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, Math.round(n / CANVAS_ZOOM_STEP) * CANVAS_ZOOM_STEP)),
      }),
      canvasDensity: 'comfortable',
      setCanvasDensity: (canvasDensity) => set({ canvasDensity }),
      showCanvasTypeBadge: true,
      toggleCanvasTypeBadge: () => set((s) => ({ showCanvasTypeBadge: !s.showCanvasTypeBadge })),
      subtleCanvasTreeLines: false,
      toggleSubtleCanvasTreeLines: () => set((s) => ({ subtleCanvasTreeLines: !s.subtleCanvasTreeLines })),
      resetCanvasDisplaySettings: () => set({
        canvasZoom: 1,
        canvasDensity: 'comfortable',
        showCanvasTypeBadge: true,
        subtleCanvasTreeLines: false,
      }),
    }),
    {
      name: 'nexus-preferences',
    }
  )
)

