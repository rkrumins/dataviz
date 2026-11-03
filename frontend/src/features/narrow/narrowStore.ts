/**
 * The canvas's narrowing: what is applied, and what the composer is drafting.
 *
 * One narrowing per canvas, held with the view it was made in — a narrowing never
 * follows the reader into another view. What the canvas draws from it (which rows
 * stay, how many members each container holds) is worked out once, when it is
 * applied, and read row by row through the selectors below: each row subscribes
 * to its own answer, so applying a narrowing re-renders the rows that change.
 */
import { create } from 'zustand'

import type { MembershipResult, MembershipSpec } from '@/types/membership'

import { visibilityOf, type NarrowVisibility } from './model'

export interface NarrowDraft {
  spec: MembershipSpec
  /** Words for the seeds — a name, "3 entities", "the search's matches". */
  seedsLabel: string
  /** Names of URN seeds, for the composer's removable chips. */
  seedNames?: Record<string, string>
}

export interface AppliedNarrow extends NarrowDraft {
  result: MembershipResult
  visibility: NarrowVisibility
}

interface NarrowState {
  viewId: string | null
  applied: AppliedNarrow | null
  composer: NarrowDraft | null
  /** Narrow the canvas of `viewId` to a resolved scope. */
  apply: (viewId: string, draft: NarrowDraft, result: MembershipResult) => void
  /** Show the whole view again. */
  clear: () => void
  openComposer: (viewId: string, draft: NarrowDraft) => void
  closeComposer: () => void
}

export const useNarrowStore = create<NarrowState>((set, get) => ({
  viewId: null,
  applied: null,
  composer: null,
  apply: (viewId, draft, result) => set({
    viewId,
    applied: { ...draft, result, visibility: visibilityOf(result) },
    composer: null,
  }),
  clear: () => set({ applied: null, composer: null }),
  openComposer: (viewId, draft) => {
    // A composer opened in another view starts that view afresh.
    if (get().viewId !== viewId) set({ viewId, applied: null })
    set({ composer: draft })
  },
  closeComposer: () => set({ composer: null }),
}))

/** What the canvas draws from the narrowing, or null for the whole view. */
export function useNarrowVisibility(): NarrowVisibility | null {
  return useNarrowStore((s) => s.applied?.visibility ?? null)
}

/** Why an entity is in the narrowed canvas, if it is. */
export function useNarrowMember(urn: string | undefined) {
  return useNarrowStore((s) => (urn ? s.applied?.visibility.byUrn.get(urn) : undefined))
}

/** How many of the narrowed canvas's members are inside an entity. */
export function useNarrowInside(urn: string | undefined): number {
  return useNarrowStore((s) => (urn ? s.applied?.visibility.ancestors.get(urn) ?? 0 : 0))
}
