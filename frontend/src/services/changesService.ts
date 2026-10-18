/**
 * Change-manifest client.
 *
 * One request that answers "which of the things I am showing have
 * moved?" for every surface at once, in place of the seven idle polls
 * those surfaces used to run on their own timers.
 */
import { authFetch } from './apiClient'

const CHANGES_URL = '/api/v1/changes'

/** Topic name → version counter. Absent topics are 0. */
export type ChangeVersions = Record<string, number>

/** What changed, and how long to wait before asking again. */
export interface ChangeManifest {
  topics: ChangeVersions
  /**
   * The admin's Live updates interval. Carried here rather than built
   * into the bundle, so a change applies at each browser's next check.
   */
  checkAfterSeconds?: number
}

/**
 * Read the current version of every topic this session subscribes to.
 *
 * Topics are derived server-side from the session, so there is nothing
 * to pass and nothing a client could ask for that it is not entitled to.
 *
 * Throws on failure — including the 503 the server returns when it
 * cannot reach the registry. That refusal is deliberate and must not be
 * smoothed over here: a manifest of zeros would mean "everything you
 * hold is stale" and would send the client to refetch every surface at
 * the exact moment the backend is already struggling.
 */
export async function fetchChangeManifest(): Promise<ChangeManifest> {
  const body = await authFetch<ChangeManifest>(CHANGES_URL)
  return { topics: body?.topics ?? {}, checkAfterSeconds: body?.checkAfterSeconds }
}
