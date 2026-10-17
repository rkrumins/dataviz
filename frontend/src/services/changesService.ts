/**
 * Change-manifest client.
 *
 * One request that answers "which of the things I am showing have
 * moved?" for every surface at once, in place of the nine idle polls
 * each of those surfaces used to run on its own timer.
 */
import { authFetch } from './apiClient'

const CHANGES_URL = '/api/v1/changes'

/** Topic name → version counter. Absent topics are 0. */
export type ChangeVersions = Record<string, number>

interface ChangeManifestResponse {
  topics: ChangeVersions
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
export async function fetchChangeManifest(): Promise<ChangeVersions> {
  const body = await authFetch<ChangeManifestResponse>(CHANGES_URL)
  return body?.topics ?? {}
}
