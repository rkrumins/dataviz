/**
 * The people the People filter offers, and the signed-in person among them.
 */
import type { ViewFacetsResponse } from '@/services/viewApiService'

export interface PersonOption {
  userId: string
  displayName: string
  email?: string | null
  avatarId?: string | null
  /** Views they created or last edited, each once. */
  count: number
  createdCount: number
  editedCount: number
  publishedCount: number
}

/** The people a filter can pick from. Servers that predate the People filter list
 *  creators only — they still work, with "created" the only role that counts. */
export function peopleFromFacets(facets: ViewFacetsResponse): PersonOption[] {
  if (facets.contributors) return facets.contributors
  return facets.creators.map(c => ({
    userId: c.userId, displayName: c.displayName, email: c.email ?? null, avatarId: null,
    count: c.count, createdCount: c.count, editedCount: 0, publishedCount: 0,
  }))
}

export interface CurrentPerson {
  id: string
  name: string
  email?: string | null
  avatarId?: string | null
}

/** The signed-in user as the People filter shows them. */
export function currentPersonOf(user: {
  id: string; email: string; firstName?: string; lastName?: string
  displayName?: string; avatarId?: string | null
} | null): CurrentPerson | null {
  if (!user) return null
  const name = user.displayName || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email
  return { id: user.id, name, email: user.email, avatarId: user.avatarId ?? null }
}
