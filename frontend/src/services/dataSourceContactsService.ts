/**
 * A data source's named contacts — its Owner and Stewards, the people to ask about its
 * data. When nobody is named they are worked out (whoever created it, the people named
 * on the request it came from, else the workspace's admins), and `via` says how.
 * Anyone who manages the source changes the Stewards; only the workspace's admins or
 * the current Owner change the Owner.
 */
import { authFetch } from './apiClient'
import type { ProfilePerson } from './peopleService'

export type ContactVia =
    | 'creator' | 'editor_grant' | 'named_owner' | 'named_steward'
    | 'created_source' | 'data_request' | 'workspace_admin' | 'org_admin'

export interface ContactEntry {
    subjectType: 'user' | 'group'
    subjectId: string
    name: string
    memberCount: number | null
    via: ContactVia
}

export interface DataSourceContacts {
    owner: ContactEntry | null
    stewards: ContactEntry[]
    provenance: 'named' | 'derived' | 'fallback'
    updatedAt: string | null
    canEdit: boolean
    canEditOwner: boolean
    people: Record<string, ProfilePerson>
}

export interface ContactRef { subjectType: 'user' | 'group'; subjectId: string }

/** The query that holds a source's contacts — the contacts card and the About card share it. */
export const contactsKey = (wsId: string, dsId: string) => ['data-source-contacts', wsId, dsId] as const

const path = (wsId: string, dsId: string) =>
    `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/data-sources/${encodeURIComponent(dsId)}/contacts`

export const dataSourceContactsService = {
    get: (wsId: string, dsId: string) => authFetch<DataSourceContacts>(path(wsId, dsId)),
    save: (wsId: string, dsId: string, body: { owner: ContactRef | null; stewards: ContactRef[]; expectedUpdatedAt: string | null }) =>
        authFetch<DataSourceContacts>(path(wsId, dsId), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
}

/** How a contact came to be one, in words. */
export const VIA_LABEL: Record<ContactVia, string> = {
    creator: 'Created the view',
    editor_grant: 'Can edit the view',
    named_owner: 'Owner',
    named_steward: 'Steward',
    created_source: 'Connected this source',
    data_request: 'Asked for this data',
    workspace_admin: 'Workspace admin',
    org_admin: 'Org Admin',
}
