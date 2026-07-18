import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'

/** Visual density of list/grid items in the Explorer page. */
export type ExplorerDensity = 'compact' | 'comfortable' | 'spacious'

/** Visual density of layer column tree items in the Context View canvas. */
export type CanvasDensity = 'compact' | 'comfortable' | 'spacious'

// Canvas zoom range — wide enough to support both tiny-overview ("zoom out
// to see the whole hierarchy") and large-text accessibility ("zoom in for
// readability") without forcing users into browser zoom (which scales the
// chrome too). Step is 0.05 (5%) so the slider feels precise without
// flooding the value space.
export const CANVAS_ZOOM_MIN = 0.5
export const CANVAS_ZOOM_MAX = 2.5
export const CANVAS_ZOOM_STEP = 0.05

/**
 * How lineage edges render on the canvas.
 *  - 'stubs'  : every node with lineage shows a small stub; real edges materialize on hover/click.
 *  - 'auto'   : all real edges below `autoStubThreshold`; above it the STRONGEST flows (by
 *               bundled edge count) render up to the threshold as a budget, per-node
 *               indicators summarize the rest, and hover/selection materializes a node's
 *               (also budget-capped) fan. A status chip reports shown/total with
 *               escalation to 'raw'.
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

  // Accessibility — optional "calm mode". Default OFF; the default
  // experience keeps full premium motion. When on, framer honours it via
  // <MotionConfig reducedMotion="always"> and CSS via the .reduce-motion
  // class on <html>.
  reducedMotion: boolean
  setReducedMotion: (v: boolean) => void

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
  /**
   * Show the "N connections not on canvas" indicators. Views are subsets
   * of a Data Source — a curated view legitimately excludes upstream /
   * downstream partners, so the missing-link alerts are informative for
   * some users and noise for others. Toggleable from Display → Lineage.
   */
  showMissingConnectionIndicators: boolean
  toggleMissingConnectionIndicators: () => void


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

  // Icon picker — recently used Lucide icon names (most recent first).
  recentIcons: string[]
  addRecentIcon: (name: string) => void

  // Ontology Schema page sidebar — survives refresh (search stays ephemeral).
  ontologySidebar: {
    collapsed: boolean
    width: number | null
    groupBy: string
    statusFilter: string
    usageFilter: string
  }
  setOntologySidebarPrefs: (prefs: Partial<PreferencesState['ontologySidebar']>) => void
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

      // Accessibility — off by default (full premium motion for everyone).
      reducedMotion: false,
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),

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
      showMissingConnectionIndicators: true,
      toggleMissingConnectionIndicators: () =>
        set((state) => ({ showMissingConnectionIndicators: !state.showMissingConnectionIndicators })),

      // User avatar
      avatarId: null,
      setAvatarId: (avatarId) => set({ avatarId }),

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
      // Default to 'spacious' so the canvas presents at maximum readability
      // out of the box (larger rows + icons + text). Existing users keep
      // whatever density they've persisted; this default only applies to
      // first-load state or after Reset.
      canvasDensity: 'spacious',
      setCanvasDensity: (canvasDensity) => set({ canvasDensity }),
      showCanvasTypeBadge: true,
      toggleCanvasTypeBadge: () => set((s) => ({ showCanvasTypeBadge: !s.showCanvasTypeBadge })),
      subtleCanvasTreeLines: false,
      toggleSubtleCanvasTreeLines: () => set((s) => ({ subtleCanvasTreeLines: !s.subtleCanvasTreeLines })),
      resetCanvasDisplaySettings: () => set({
        canvasZoom: 1,
        canvasDensity: 'spacious',
        showCanvasTypeBadge: true,
        subtleCanvasTreeLines: false,
      }),

      // Icon picker recents
      recentIcons: [],
      addRecentIcon: (name) => set((s) => ({
        recentIcons: [name, ...s.recentIcons.filter(n => n !== name)].slice(0, 12),
      })),

      // Ontology Schema sidebar
      ontologySidebar: {
        collapsed: false,
        width: null,
        groupBy: 'flat',
        statusFilter: 'all',
        usageFilter: 'all',
      },
      setOntologySidebarPrefs: (prefs) => set((s) => ({
        ontologySidebar: { ...s.ontologySidebar, ...prefs },
      })),
    }),
    {
      name: 'nexus-preferences',
    }
  )
)

