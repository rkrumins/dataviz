/**
 * What a data source is, and whether to trust it: its own description (else the catalog
 * item's), links and tags — anyone who manages the source edits those — and its trust
 * status, sensitivity and a note, which its named Owner and Stewards and the workspace's
 * admins set. Also how it got here (who connected it, when, how, and from which data
 * request) and its history. Every save carries the `updatedAt` it was read at; a source
 * changed since answers 409 `stale` with what it is now.
 */
import { authFetch } from './apiClient'
import type { ActivityEvent } from './activityService'
import type { ProfilePerson } from './peopleService'

export const DATA_SOURCE_METADATA_FEATURE = 'dataSourceMetadataEnabled'

export type Classification = 'public' | 'internal' | 'confidential' | 'restricted'
export type TrustStatus = 'certified' | 'in_review' | 'deprecated'
export type OnboardingHow = 'catalog' | 'blank' | 'view_package' | 'fork' | 'provider'

export const CLASSIFICATIONS: readonly Classification[] = ['public', 'internal', 'confidential', 'restricted']
export const TRUST_STATUSES: readonly TrustStatus[] = ['certified', 'in_review', 'deprecated']

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
    public: 'Public', internal: 'Internal', confidential: 'Confidential', restricted: 'Restricted',
}
export const TRUST_LABEL: Record<TrustStatus, string> = {
    certified: 'Certified', in_review: 'In review', deprecated: 'Deprecated',
}
export const HOW_LABEL: Record<OnboardingHow, string> = {
    catalog: 'From the catalog',
    blank: 'Started blank',
    view_package: 'From a view package',
    fork: 'A fork of another source',
    provider: 'Straight from its provider',
}

/** The server's limits, so a form can say so before it asks. */
export const LIMITS = { description: 4000, links: 10, linkLabel: 80, url: 2048, tags: 20, tag: 40, note: 500 } as const

export interface DataSourceLink { label: string; url: string }

export interface DataSourceMetadata {
    dataSourceId: string
    description: string | null
    catalogDescription: string | null
    links: DataSourceLink[]
    tags: string[]
    classification: Classification | null
    trustStatus: TrustStatus | null
    trustNote: string | null
    /** Who set the CURRENT status, and when. */
    trustStatusBy: ProfilePerson | null
    trustStatusAt: string | null
    /** The last edit — also what a save says it was read at. */
    updatedAt: string | null
    updatedBy: ProfilePerson | null
    onboarding: {
        at: string | null
        by: ProfilePerson | null
        how: OnboardingHow | null
        fromRequest: { id: string; title: string; requesterName: string | null; requestedAt: string; connectedAt: string | null } | null
    }
    canEdit: boolean
    canEditTrust: boolean
}

export interface DetailsBody { description: string | null; links: DataSourceLink[]; tags: string[] }
export interface TrustBody { classification: Classification | null; trustStatus: TrustStatus | null; trustNote: string | null }

export interface SourceActivityPage { events: ActivityEvent[]; nextCursor: string | null }

/** Only a web address opens from a link: never `javascript:` or anything else. */
export function isWebUrl(url: string): boolean {
    try {
        const u = new URL(url)
        return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
        return false
    }
}

const base = (wsId: string, dsId: string) =>
    `/api/v1/admin/workspaces/${encodeURIComponent(wsId)}/data-sources/${encodeURIComponent(dsId)}`
const put = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const dataSourceMetadataService = {
    get: (wsId: string, dsId: string) => authFetch<DataSourceMetadata>(`${base(wsId, dsId)}/metadata`),
    saveDetails: (wsId: string, dsId: string, body: DetailsBody & { expectedUpdatedAt: string | null }) =>
        authFetch<DataSourceMetadata>(`${base(wsId, dsId)}/metadata`, put(body)),
    saveTrust: (wsId: string, dsId: string, body: TrustBody & { expectedUpdatedAt: string | null }) =>
        authFetch<DataSourceMetadata>(`${base(wsId, dsId)}/metadata/trust`, put(body)),
    listActivity: (wsId: string, dsId: string, cursor?: string | null) => {
        const q = new URLSearchParams({ limit: '30' })
        if (cursor) q.set('cursor', cursor)
        return authFetch<SourceActivityPage>(`${base(wsId, dsId)}/activity/events?${q}`)
    },
}
