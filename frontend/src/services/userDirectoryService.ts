/**
 * People/group directory for share pickers — ``GET /api/v1/directory``.
 *
 * Available to ANY signed-in user (the share dialog's picker previously
 * called the admin-only user listing, so non-admin creators saw an empty
 * picker). Search-driven with a server-side cap; active subjects only.
 */
import { authFetch } from './apiClient'

export interface DirectoryUser {
    id: string
    displayName: string
    email: string
}

export interface DirectoryGroup {
    id: string
    name: string
    memberCount: number
}

export interface DirectoryResponse {
    users: DirectoryUser[]
    groups: DirectoryGroup[]
}

export async function searchDirectory(
    q: string,
    opts?: { types?: Array<'user' | 'group'>; limit?: number },
): Promise<DirectoryResponse> {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    if (opts?.types?.length) sp.set('types', opts.types.join(','))
    if (opts?.limit) sp.set('limit', String(opts.limit))
    const qs = sp.toString()
    return authFetch<DirectoryResponse>(`/api/v1/directory${qs ? `?${qs}` : ''}`)
}

/** A person named by id — `GET /api/v1/directory/people?ids=`. */
export interface DirectoryPerson {
    id: string
    displayName: string
    /** Absent for a deleted account: it is named, not contactable. */
    email: string | null
    deleted: boolean
    avatarId?: string | null
}

/** The server names at most this many ids per request. */
export const PEOPLE_PER_REQUEST = 100

/**
 * Name the people a record holds the ids of — who triggered a run, who added
 * a member. Open to any signed-in user; accounts since deleted are included
 * and marked. An id that names nobody is simply absent from the answer.
 */
export async function peopleById(ids: string[]): Promise<DirectoryPerson[]> {
    const wanted = [...new Set(ids.filter(Boolean))]
    const batches: string[][] = []
    for (let i = 0; i < wanted.length; i += PEOPLE_PER_REQUEST) {
        batches.push(wanted.slice(i, i + PEOPLE_PER_REQUEST))
    }
    const answers = await Promise.all(batches.map(batch => authFetch<DirectoryPerson[]>(
        `/api/v1/directory/people?ids=${encodeURIComponent(batch.join(','))}`,
    )))
    return answers.flat()
}
