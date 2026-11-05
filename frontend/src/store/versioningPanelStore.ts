/**
 * versioningPanelStore — a one-shot bridge for opening the ViewVersioningPanel
 * from OUTSIDE the CanvasVersioningBar (which owns the panel state).
 *
 * The Context View header's "Changes" button lives far from the bar and stays
 * store-free itself; it asks the canvas to call `openPanel('changes')`, and the
 * bar's subscription picks up the request, opens the panel on that tab, and
 * clears it. Kept deliberately tiny and NON-persisted — it carries a transient
 * request, not durable state (mirrors branchStore's minimal style).
 *
 * `openCompare` asks for History on a comparison of two revisions — from the revision banner, or
 * for a past revision the canvas can't draw, with `notice` saying why it is shown instead.
 */
import { create } from 'zustand'
import type { ViewPanelTab } from '@/features/versioning/components/ViewVersioningPanel'

/** Two revisions of Published to compare; `toSeq` null is Published as it is now. */
export interface CompareRequest {
  fromSeq: number
  toSeq: number | null
  /** Shown instead of opening `fromSeq` on the canvas, which can't draw it. */
  notice?: 'too_far' | 'fork'
}

interface VersioningPanelState {
  /** The tab the panel should open on, or null when there's no pending request. */
  requestedTab: ViewPanelTab | null
  /** The comparison History should open on, with the request for its tab. */
  requestedCompare: CompareRequest | null
  openPanel: (tab: ViewPanelTab) => void
  openCompare: (compare: CompareRequest) => void
  clearRequest: () => void
}

export const useVersioningPanelStore = create<VersioningPanelState>((set) => ({
  requestedTab: null,
  requestedCompare: null,
  openPanel: (tab) => set({ requestedTab: tab, requestedCompare: null }),
  openCompare: (compare) => set({ requestedTab: 'history', requestedCompare: compare }),
  clearRequest: () => set({ requestedTab: null, requestedCompare: null }),
}))
