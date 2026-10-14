/**
 * The people who shaped a view — its creator, its last editor and whoever
 * published its latest data — each once, in that order, with what they did.
 * The contributor trail draws them; the preview drawer lists them.
 */
import { timeAgo, toUtcDate } from '@/lib/timeAgo'
import type { View } from '@/services/viewApiService'

export interface Contributor {
  userId: string
  name: string
  email: string | null
  avatarId: string | null
  /** What they did, in order — "Created · 3 Oct", "Last edited · 2h ago". */
  roles: string[]
}

/** A view saved once carries an `updatedAt` a moment after its `createdAt`;
 *  that is its creation, not an edit. */
const EDIT_AFTER_MS = 1000

function shortDate(ts: string): string {
  const d = toUtcDate(ts)
  if (!d) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function contributorsOf(view: View): Contributor[] {
  const people = new Map<string, Contributor>()
  const add = (
    id: string | null | undefined, name: string | null | undefined, email: string | null | undefined,
    avatarId: string | null | undefined, role: string,
  ) => {
    if (!id) return
    const known = people.get(id)
    if (known) known.roles.push(role)
    else people.set(id, { userId: id, name: name || 'Unknown', email: email ?? null, avatarId: avatarId ?? null, roles: [role] })
  }
  add(view.createdBy, view.createdByName, view.createdByEmail, view.createdByAvatarId, `Created · ${shortDate(view.createdAt)}`)
  const created = toUtcDate(view.createdAt)?.getTime() ?? 0
  const edited = toUtcDate(view.updatedAt)?.getTime() ?? 0
  if (edited - created > EDIT_AFTER_MS) {
    add(view.updatedBy, view.updatedByName, view.updatedByEmail, view.updatedByAvatarId, `Last edited · ${timeAgo(view.updatedAt)}`)
  }
  if (view.dataUpdatedAt) {
    add(view.dataUpdatedBy, view.dataUpdatedByName, view.dataUpdatedByEmail, view.dataUpdatedByAvatarId,
      `Published its latest data · ${timeAgo(view.dataUpdatedAt)}`)
  }
  return [...people.values()]
}
