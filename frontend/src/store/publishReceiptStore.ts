/**
 * publishReceiptStore — a one-shot receipt for "your changes are now live".
 *
 * Publishing is the moment a draft's work becomes real for everyone else, and until now it was
 * acknowledged with a notification that vanished in three seconds — the same weight as "copied to
 * clipboard". Worse, the merge can happen on a *different route* (the Reviews inbox) from the canvas
 * that should reflect it, so the confirmation has to survive a navigation.
 *
 * Hence a transient store rather than local state: the merge/publish surface writes the receipt, the
 * canvas's versioning bar renders it wherever the user lands. Same one-shot-bridge pattern as
 * `versioningPanelStore` — a *request* to show something, not durable state. Never persisted.
 */
import { create } from 'zustand'
import type { ChangeCounts } from '@/features/versioning/model/changeModel'

export interface PublishReceipt {
  /** The squash commit that landed on main — the drill-down target. */
  commitId: string
  graphId: string
  counts: ChangeCounts
  /** How it got to main: straight publish, or merged through its review. */
  via: 'publish' | 'review'
}

interface PublishReceiptState {
  receipt: PublishReceipt | null
  setReceipt: (r: PublishReceipt) => void
  clearReceipt: () => void
}

export const usePublishReceiptStore = create<PublishReceiptState>((set) => ({
  receipt: null,
  setReceipt: (receipt) => set({ receipt }),
  clearReceipt: () => set({ receipt: null }),
}))
