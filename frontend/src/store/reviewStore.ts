/**
 * reviewStore — a review of changes on the Context View: what it lists (its scope), narrowed by
 * operation, kind, type and text; the change it is on; and what shows it — the navigator on the
 * canvas, always, and the list beside it.
 *
 * The surfaces that count changes — the bar's chips, the comparison chip, the revision banner, the
 * Reviews panel's Changes tab, History's comparison — start a review with `startReview` wherever
 * the Context View can show one (`available`). Elsewhere they keep their own lists.
 *
 * Only how a person likes to review is remembered — the list open (`listPreferred`), What changed
 * open (`whatChangedOpen`): a review is about the canvas in front of you.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChangeListKind, ChangeListRow, ChangeListStatus } from '@/services/versioningApiService'
import { usePersonaStore } from './persona'

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
  /** The navigator is on the canvas: a review is under way. */
  navigatorOpen: boolean
  /** The list is open in the canvas's left rail. */
  listOpen: boolean
  setListOpen: (open: boolean) => void
  /** Open or close the list, remembering the choice for the next review. */
  toggleList: () => void
  /** Whether this person keeps the list open, once they have chosen; else their persona decides:
   *  technical users get it, business users the navigator alone. */
  listPreferred: boolean | null
  /** The navigator's "What changed" is open: each change it visits shows field by field.
   *  Remembered, like the list. */
  whatChangedOpen: boolean
  toggleWhatChanged: () => void
  /** null: what the canvas shows (`useChangesScope`'s default). */
  scope: ReviewScope | null
  /** One operation at a time; null for all of them. */
  operation: ChangeListStatus | null
  filter: ReviewFilter
  /** The change the review is on, and where it sits in the list as narrowed. */
  current: ChangeListRow | null
  position: number
  /** Bumped by every visit, so going back to the change already current finds it again. */
  visits: number
  visit: (row: ChangeListRow, position: number) => void
  /** How finding the current change on the canvas went: under way, or its outcome. */
  found: 'looking' | 'found' | 'nearby' | 'missing' | null
  setFound: (found: ReviewState['found']) => void
  /** Open a review on `scope` (or what the canvas shows), at `operation` (or all), narrowed by
   *  nothing else: what was asked for is never hidden by an earlier search. */
  startReview: (opts?: { scope?: ReviewScope | null; operation?: ChangeListStatus | null }) => void
  endReview: () => void
  setScope: (scope: ReviewScope | null) => void
  setOperation: (operation: ChangeListStatus | null) => void
  setFilter: (filter: ReviewFilter) => void
}

/** Another list starts at its top. */
const FROM_THE_TOP = { current: null, position: 0, found: null } as const

export const useReviewStore = create<ReviewState>()(
  persist(
    (set) => ({
      available: false,
      setAvailable: (available) => set((s) => (s.available === available ? s : { available })),
      navigatorOpen: false,
      listOpen: false,
      setListOpen: (listOpen) => set((s) => (s.listOpen === listOpen ? s : { listOpen })),
      toggleList: () => set((s) => ({ listOpen: !s.listOpen, listPreferred: !s.listOpen })),
      listPreferred: null,
      whatChangedOpen: false,
      toggleWhatChanged: () => set((s) => ({ whatChangedOpen: !s.whatChangedOpen })),
      scope: null,
      operation: null,
      filter: {},
      current: null,
      position: 0,
      visits: 0,
      visit: (current, position) => set((s) => ({ current, position, visits: s.visits + 1 })),
      found: null,
      setFound: (found) => set({ found }),
      startReview: ({ scope = null, operation = null } = {}) =>
        set((s) => ({
          navigatorOpen: true,
          listOpen: s.listPreferred ?? usePersonaStore.getState().mode === 'technical',
          scope, operation, filter: {}, ...FROM_THE_TOP,
        })),
      endReview: () => set({ navigatorOpen: false, listOpen: false, current: null, found: null }),
      // Another scope has other types: its type starts afresh.
      setScope: (scope) => set((s) => ({ scope, filter: { ...s.filter, type: undefined }, ...FROM_THE_TOP })),
      setOperation: (operation) => set({ operation, ...FROM_THE_TOP }),
      setFilter: (filter) => set({ filter, ...FROM_THE_TOP }),
    }),
    {
      name: 'nexus-review',
      partialize: (s) => ({ listPreferred: s.listPreferred, whatChangedOpen: s.whatChangedOpen }),
    },
  ),
)
