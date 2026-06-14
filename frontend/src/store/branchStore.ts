/**
 * BranchStore — the single source of truth for "which branch are we editing/viewing"
 * and "is the diff overlay on". Read by `ViewExecutionContext` (to scope the graph
 * provider's `?branchId=`), by the canvases (to tint diffed nodes), and by the
 * versioning chrome (BranchSwitcher / DraftBanner).
 *
 * Deliberately a separate, NON-persisted store from `canvas.ts`: the canvas store is
 * localStorage-persisted and version-counted on every graph mutation. Branch identity
 * must not bump the graph `_version` (it's not a graph edit), and a stale persisted
 * branch id across reloads would be a footgun — branch context is re-resolved per
 * session from `resolveGraph`.
 */
import { create } from 'zustand'
import type { ResolveResponse } from '@/services/versioningApiService'
import type { ChangeSet } from '@/features/versioning/model/changeModel'

interface BranchState {
  /** The (workspace, data source) this branch context is scoped to — a branchId is
   *  only valid for its own graph, so reads in a *different* scope must ignore it. */
  workspaceId: string | null
  dataSourceId: string | null

  /** The versioned graph backing the active data source (null until resolved). */
  graphId: string | null
  mainBranchId: string | null
  mainHeadCommitSeq: number

  /** null = trunk/main (no `?branchId=` on reads); a `br_…` id = an open draft. */
  currentBranchId: string | null
  /** The view a draft was opened from, threaded into `openDraft({originatingViewId})`. */
  originatingViewId: string | null

  /** The draft-vs-main change set (committed branch changes). Owned by the CanvasVersioningBar
   *  effect; cleared only on a branch switch. */
  activeChangeSet: ChangeSet | null
  /** Committed-vs-main highlighting on the canvas is ON by default; this hides it so the user
   *  isn't confused by older committed work. Staged (uncommitted) edits ALWAYS show. */
  committedDiffHidden: boolean

  /** Bumped on publish/merge so live `main` reads refetch (folded into providerVersion). */
  mainEpoch: number

  /** True when the active branch is a draft (not trunk). */
  isDraftMode: () => boolean
  /** The branchId to use for reads in (wsId, dataSourceId) — null unless the scope matches. */
  branchIdForScope: (wsId: string, dataSourceId: string | null) => string | null

  setResolved: (scope: { workspaceId: string; dataSourceId: string }, r: ResolveResponse) => void
  switchToMain: () => void
  switchToDraft: (branchId: string, originatingViewId?: string | null) => void
  setCommittedDiffHidden: (hidden: boolean) => void
  setActiveChangeSet: (cs: ChangeSet | null) => void
  bumpMainEpoch: () => void
  /** Clear all branch context — call when leaving a data source / view. */
  reset: () => void
}

const INITIAL = {
  workspaceId: null,
  dataSourceId: null,
  graphId: null,
  mainBranchId: null,
  mainHeadCommitSeq: 0,
  currentBranchId: null,
  originatingViewId: null,
  activeChangeSet: null,
  committedDiffHidden: false,
  mainEpoch: 0,
} as const

export const useBranchStore = create<BranchState>((set, get) => ({
  ...INITIAL,

  isDraftMode: () => {
    const { currentBranchId, mainBranchId } = get()
    return !!currentBranchId && currentBranchId !== mainBranchId
  },

  branchIdForScope: (wsId, dataSourceId) => {
    const s = get()
    if (s.workspaceId !== wsId || s.dataSourceId !== dataSourceId) return null
    return s.currentBranchId
  },

  setResolved: (scope, r) =>
    set((s) => {
      const sameScope = s.workspaceId === scope.workspaceId && s.dataSourceId === scope.dataSourceId
      return {
        workspaceId: scope.workspaceId,
        dataSourceId: scope.dataSourceId,
        graphId: r.graphId,
        mainBranchId: r.mainBranchId,
        mainHeadCommitSeq: r.mainHeadCommitSeq,
        // Resolving a *different* data source resets the active branch to trunk.
        ...(sameScope
          ? {}
          : { currentBranchId: null, originatingViewId: null, activeChangeSet: null }),
      }
    }),

  switchToMain: () =>
    set({
      currentBranchId: null,
      originatingViewId: null,
      activeChangeSet: null,
    }),

  switchToDraft: (branchId, originatingViewId = null) =>
    set({
      currentBranchId: branchId,
      originatingViewId,
      // Leaving any prior diff set behind — it described a different branch.
      activeChangeSet: null,
    }),

  // The committed-vs-main highlight is a view preference: it survives branch switches (so the
  // user's show/hide choice sticks) and never touches activeChangeSet (the data, owned by the
  // CanvasVersioningBar effect, cleared only on a branch change).
  setCommittedDiffHidden: (hidden) => set({ committedDiffHidden: hidden }),

  setActiveChangeSet: (cs) => set({ activeChangeSet: cs }),

  bumpMainEpoch: () => set((s) => ({ mainEpoch: s.mainEpoch + 1 })),

  reset: () => set({ ...INITIAL }),
}))

// ── Selector hooks (memo-friendly slices) ──────────────────────────────────
export const useCurrentBranchId = () => useBranchStore((s) => s.currentBranchId)
export const useIsDraftMode = () =>
  useBranchStore((s) => !!s.currentBranchId && s.currentBranchId !== s.mainBranchId)
export const useGraphId = () => useBranchStore((s) => s.graphId)
export const useCommittedDiffHidden = () => useBranchStore((s) => s.committedDiffHidden)

/** The branchId to apply to reads in (wsId, dataSourceId), or null if the active
 *  branch context belongs to a different scope (or is trunk). */
export const useEffectiveBranchId = (wsId: string, dataSourceId: string | null): string | null =>
  useBranchStore((s) =>
    s.workspaceId === wsId && s.dataSourceId === dataSourceId ? s.currentBranchId : null,
  )
