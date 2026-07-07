/**
 * createLinkStore — open/close state for the click-based CreateLinkPopover
 * (the "Link to…" lineage-connect flow shared by all three canvases + the
 * Hierarchy Builder outline).
 *
 * Mirrors hierarchyBuilderStore: `open()` calls `ensureDraftOpen()` BEFORE
 * setting state. Creating a link stages a `create_edge` change (the same draft
 * contract as adding entities), and switching branches reloads the canvas —
 * opening a draft after the first stage would discard it. Centralizing the
 * guard here means every caller gets it for free.
 */
import { create } from 'zustand'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'

interface CreateLinkState {
  isOpen: boolean
  /** The link's source entity urn (== canvas node id == backend entity_id). */
  sourceUrn: string | null
  /** Viewport point the glass popover floats near (context-menu point / row edge). */
  anchor: { x: number; y: number } | null
  open: (opts: { sourceUrn: string; anchor: { x: number; y: number } }) => void
  close: () => void
}

export const useCreateLinkStore = create<CreateLinkState>((set) => ({
  isOpen: false,
  sourceUrn: null,
  anchor: null,

  open: (opts) => {
    void ensureDraftOpen()
    set({ isOpen: true, sourceUrn: opts.sourceUrn, anchor: opts.anchor })
  },

  close: () => set({ isOpen: false, sourceUrn: null, anchor: null }),
}))
