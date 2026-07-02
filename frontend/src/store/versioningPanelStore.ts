/**
 * versioningPanelStore — a one-shot bridge for opening the ViewVersioningPanel
 * from OUTSIDE the CanvasVersioningBar (which owns the panel state).
 *
 * The Context View header's "Changes" button lives far from the bar and stays
 * store-free itself; it asks the canvas to call `openPanel('changes')`, and the
 * bar's subscription picks up the request, opens the panel on that tab, and
 * clears it. Kept deliberately tiny and NON-persisted — it carries a transient
 * request, not durable state (mirrors branchStore's minimal style).
 */
import { create } from 'zustand'
import type { ViewPanelTab } from '@/features/versioning/components/ViewVersioningPanel'

interface VersioningPanelState {
  /** The tab the panel should open on, or null when there's no pending request. */
  requestedTab: ViewPanelTab | null
  openPanel: (tab: ViewPanelTab) => void
  clearRequest: () => void
}

export const useVersioningPanelStore = create<VersioningPanelState>((set) => ({
  requestedTab: null,
  openPanel: (tab) => set({ requestedTab: tab }),
  clearRequest: () => set({ requestedTab: null }),
}))
