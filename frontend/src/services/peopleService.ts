/**
 * Someone's profile, as the reader may see it: who they are, the workspaces they run
 * and the data sources they look after — each only where the reader can see it. The
 * views they own come from the views list (`createdBy`).
 */
import { authFetch } from './apiClient'

export interface ProfilePerson {
    id: string
    displayName: string
    email: string | null
    avatarId: string | null
    hasImage: boolean
    deleted: boolean
}

export interface PersonDataContact {
    dataSourceId: string
    dataSourceName: string
    workspaceId: string
    workspaceName: string
    role: 'owner' | 'steward'
    via: 'direct' | 'group'
}

export interface PersonProfile {
    person: ProfilePerson
    isMe: boolean
    workspacesTheyRun: { id: string; name: string }[]
    dataContacts: PersonDataContact[]
}

export const peopleService = {
    profile: (userId: string) => authFetch<PersonProfile>(`/api/v1/people/${encodeURIComponent(userId)}`),
}
