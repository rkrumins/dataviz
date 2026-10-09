/**
 * The problems that made the last save refuse (nothing was written). Review & Save lists them with
 * their reasons; a problem goes away with the change that caused it (discarded, or saved on a
 * retry) — readers filter against the live staged changes, so there is nothing to keep in sync.
 */
import { create } from 'zustand'
import type { SaveProblem } from '@/features/versioning/model/saveProblems'

interface SaveProblemsState {
  problems: SaveProblem[]
  report: (problems: SaveProblem[]) => void
  clear: () => void
}

export const useSaveProblemsStore = create<SaveProblemsState>((set) => ({
  problems: [],
  report: (problems) => set({ problems }),
  clear: () => set({ problems: [] }),
}))

/** The problems still standing: tied to a change that is still staged, or to none we could match. */
export function liveProblems(problems: readonly SaveProblem[], stagedIds: ReadonlySet<string>): SaveProblem[] {
  return problems.filter((p) => p.changeIds.length === 0 || p.changeIds.some((id) => stagedIds.has(id)))
}
