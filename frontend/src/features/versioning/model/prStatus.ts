/**
 * The PR lifecycle predicate, in one place.
 *
 * A PR is LIVE until it is merged or closed — those two are the only terminal states (the backend's
 * `_TERMINAL_PR_STATUS`). Everything else (`open`, `mergeable`, `approved`, `conflicts`) is a live
 * PR that still points at its source branch and can still be merged.
 *
 * This predicate carries a real invariant — **at most one live PR per source branch** — so it must
 * have exactly one spelling. It used to have three (a `Set` in ViewPrList, an inline `!==` pair in
 * BranchSwitcher, another in PrDetailDrawer), which is how the branch that already had an open PR
 * could still be offered a "Submit for review" button.
 */
import type { PullRequest } from '@/services/versioningApiService'

/** Merged or closed — the PR is history and no longer holds its source branch. */
export const PR_TERMINAL_STATUSES = ['merged', 'closed'] as const

export const isTerminalPr = (status: string | null | undefined): boolean =>
  status === 'merged' || status === 'closed'

/** Still open against its source branch: new commits on that branch land in THIS review. */
export const isLivePr = (pr: Pick<PullRequest, 'status'>): boolean => !isTerminalPr(pr.status)

/** The live PR for `branchId`, if any. There is at most one — the backend enforces it. */
export function findLivePrForBranch(
  prs: PullRequest[] | undefined,
  branchId: string | null | undefined,
): PullRequest | undefined {
  if (!branchId) return undefined
  return prs?.find((p) => p.sourceBranchId === branchId && isLivePr(p))
}
