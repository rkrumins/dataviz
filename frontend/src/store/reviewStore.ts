/**
 * reviewStore — a review of changes on the Context View: what it lists (its scope), narrowed by
 * operation, kind, type and text, and whether its list is open beside the canvas.
 *
 * The surfaces that count changes — the bar's chips, the comparison chip, the revision banner, the
 * Reviews panel's Changes tab, History's comparison — start a review with `startReview` wherever
 * the Context View can show one (`available`). Elsewhere they keep their own lists.
 *
 * Not persisted: a review is about the canvas in front of you.
 */
import { create } from 'zustand'
import type { ChangeListKind, ChangeListStatus } from '@/services/versioningApiService'

/** What a review lists, said relative to where the canvas is; `useChangesScope` resolves it. */
export type ReviewScope =
  /** The draft open on the canvas. */
  | { kind: 'draft' }
  /** What one revision of Published changed. */
  | { kind: 'in'; seq: number }
  /** What changed after a revision, up to the head it was opened at. */
  | { kind: 'since'; seq: number }
  /** Two revisions compared: what changed after `fromSeq`, up to and including `toSeq`. */
  | { kind: 'between'; fromSeq: number; toSeq: number }

/** The narrowing a review keeps besides its operation. */
export interface ReviewFilter {
  kind?: ChangeListKind
  type?: string
  q?: string
}

interface ReviewState {
  /** The Context View is mounted, and can show a review. */
  available: boolean
  setAvailable: (available: boolean) => void
  /** The list is open in the canvas's left rail. */
  listOpen: boolean
  setListOpen: (open: boolean) => void
  /** null: what the canvas shows (`useChangesScope`'s default). */
  scope: ReviewScope | null
  /** One operation at a time; null for all of them. */
  operation: ChangeListStatus | null
  filter: ReviewFilter
  /** Open the list on `scope` (or what the canvas shows), at `operation` (or all), narrowed by
   *  nothing else: what was asked for is never hidden by an earlier search. */
  startReview: (opts?: { scope?: ReviewScope | null; operation?: ChangeListStatus | null }) => void
  endReview: () => void
  setScope: (scope: ReviewScope | null) => void
  setOperation: (operation: ChangeListStatus | null) => void
  setFilter: (filter: ReviewFilter) => void
}

export const useReviewStore = create<ReviewState>((set) => ({
  available: false,
  setAvailable: (available) => set((s) => (s.available === available ? s : { available })),
  listOpen: false,
  setListOpen: (listOpen) => set((s) => (s.listOpen === listOpen ? s : { listOpen })),
  scope: null,
  operation: null,
  filter: {},
  startReview: ({ scope = null, operation = null } = {}) =>
    set({ listOpen: true, scope, operation, filter: {} }),
  endReview: () => set({ listOpen: false }),
  // Another scope has other types: its type starts afresh.
  setScope: (scope) => set((s) => ({ scope, filter: { ...s.filter, type: undefined } })),
  setOperation: (operation) => set({ operation }),
  setFilter: (filter) => set({ filter }),
}))
