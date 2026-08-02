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
