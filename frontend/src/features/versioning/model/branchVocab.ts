/**
 * branchVocab — the single source of truth for the plain-language branch terminology shown to users.
 *
 * The versioned-graph engine speaks git (main / branch / commit / merge / rebase), which is opaque
 * to a non-technical audience. Everywhere a user can see it, we surface business language instead.
 * This is PRESENTATIONAL ONLY — the `?branch=` URL param, the REST API field names, and the database
 * are unchanged, so deep-links and the server contract are untouched. Change wording here, once.
 */

export const BRANCH_VOCAB = {
  /** `main` — the live version everyone sees. */
  published: 'Published',
  publishedSub: 'The live version everyone sees',
  /** a private working copy. */
  draft: 'Draft',
  draftPlural: 'Drafts',
  yourDrafts: 'Your drafts',
  /** `commit`/`checkpoint`. */
  savePoint: 'Save point',
  /** staged-but-not-saved edits. */
  unsaved: 'Unsaved changes',
  /** `merge`/`publish` — send a draft to the published version. */
  publish: 'Publish',
  /** `pull latest`/`rebase`. */
  getLatest: 'Get latest updates',
  /** draft is behind the published version. */
  updatesAvailable: 'Updates available',
  upToDate: 'Up to date',
  /** `abandon`. */
  archive: 'Archive',
  /** `merge request`. */
  reviewRequest: 'Review request',
  newDraft: 'New draft',
  manageAll: 'Manage all drafts',
  untitled: 'Untitled draft',
} as const

export type StatusTone = 'ok' | 'attention' | 'neutral'

export interface DraftStatus {
  /** behind the published version → updates are waiting to be pulled in. */
  behind: boolean
  label: string
  tone: StatusTone
}

/** Plain-language status for a draft, from its base vs. the published head. */
export function draftStatus(
  baseCommitSeq: number | null | undefined,
  publishedHead: number,
): DraftStatus {
  const behind = (baseCommitSeq ?? 0) < publishedHead
  return behind
    ? { behind, label: BRANCH_VOCAB.updatesAvailable, tone: 'attention' }
    : { behind, label: BRANCH_VOCAB.upToDate, tone: 'ok' }
}

/**
 * Human display name for an actor id/owner. Precedence: the resolved `userNames` map entry
 * (id → display name, attached by the API) → an email-munge for legacy email-shaped actors
 * (`ana.lee@acme.com` → `Ana lee`) → `'Unknown'`. A raw `usr_*` id is never shown as a label.
 */
export function ownerName(owner?: string | null, userNames?: Record<string, string>): string {
  if (!owner) return 'Unknown'
  const resolved = userNames?.[owner]
  if (resolved) return resolved
  if (!owner.includes('@')) return 'Unknown'
  const handle = owner.split('@')[0]
  const cleaned = handle.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return owner
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

/** Two-letter initials for an avatar chip — same source precedence as {@link ownerName}. */
export function ownerInitials(owner?: string | null, userNames?: Record<string, string>): string {
  if (!owner) return '?'
  const resolved = userNames?.[owner]
  if (resolved) {
    const parts = resolved.trim().split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return resolved.slice(0, 2).toUpperCase()
  }
  if (!owner.includes('@')) return '?'
  const handle = owner.split('@')[0]
  const parts = handle.split(/[._\-\s]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return handle.slice(0, 2).toUpperCase()
}
