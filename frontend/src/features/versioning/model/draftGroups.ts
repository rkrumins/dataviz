/**
 * draftGroups — a version list's drafts, by whose they are to the person reading it: their own,
 * those shared with them (as a member, or on a review of it), and the public ones. Each group keeps
 * the list's order; a group with nothing in it is left out.
 */
import type { Branch } from '@/services/versioningApiService'

export type DraftGroupKey = 'mine' | 'shared' | 'public'

export interface DraftGroup {
  key: DraftGroupKey
  label: string
  drafts: Branch[]
}

const LABELS: Record<DraftGroupKey, string> = {
  mine: 'Your drafts',
  shared: 'Shared with you',
  public: 'Public drafts',
}

export function draftGroupOf(b: Pick<Branch, 'owner' | 'myRole' | 'visibility'>, me?: string | null): DraftGroupKey {
  if (me && b.owner === me) return 'mine'
  return b.visibility === 'public' && !b.myRole ? 'public' : 'shared'
}

export function groupDrafts(drafts: Branch[], me?: string | null): DraftGroup[] {
  return (['mine', 'shared', 'public'] as const)
    .map((key) => ({ key, label: LABELS[key], drafts: drafts.filter((b) => draftGroupOf(b, me) === key) }))
    .filter((g) => g.drafts.length > 0)
}
