/**
 * Service accounts — for administrators (Administration → Service accounts),
 * and for the people who manage one (Account → API keys, and its own page).
 *
 * A service account is a principal that never signs in: an integration acts
 * as it through API keys its managers make. Its keys work while someone in
 * good standing manages it — a person, or a member of a team — and for
 * `graceDays` after the last one goes, so an integration keeps running while
 * a successor is appointed. Its keys themselves are `serviceAccountKeys(id)`
 * in apiKeyService.
 *
 * A deleted account's keys stop at once. Until `purgesAt`, 30 days on, it can
 * be restored as it was; then its keys are revoked and its roles and managers
 * removed.
 */
import { authFetch } from './apiClient'

const ADMIN = '/api/v1/admin/service-accounts'
const MINE = '/api/v1/me/service-accounts'

export type ManagerType = 'user' | 'group'

/** A person or a team, as one is named to manage an account. */
export interface ManagerRef {
    type: ManagerType
    id: string
}

export interface ServiceAccountManager extends ManagerRef {
    name: string
    email: string | null
    /** A person who could sign in now; a team with such a person in it. */
    inGoodStanding: boolean
    /** A team: how many of its members are in good standing. */
    membersInGoodStanding: number | null
    addedAt: string
    addedBy: string | null
}

export interface KeyBrief {
    id: string
    name: string
    prefix: string
    lastUsedAt: string | null
}

/** For a person about to leave: what their leaving involves. */
export interface HandOverFacts {
    /** They hold a seat on the account themselves: a hand-over moves it. */
    seat: boolean
    /** The teams through which they manage it, by name: those keep their seats. */
    teams: string[]
    /** They answer for it, and nobody else does. */
    lastManager: boolean
    /** Keys still in date that they made — they may have kept a copy. */
    keysCreatedBy: KeyBrief[]
}

export interface ServiceAccount {
    id: string
    name: string
    description: string | null
    status: 'active' | 'disabled'
    createdAt: string
    createdBy: string | null
    managers: ServiceAccountManager[]
    /** Someone in good standing answers for it now. */
    managed: boolean
    /** Exactly one person answers for it: it is stranded when they go. */
    singleManager: boolean
    /** Since when nobody has; its keys pause at `pausesAt`. */
    unmanagedSince: string | null
    pausesAt: string | null
    /** An administrator disabled or deleted it: only one of them enables or
     *  restores it again. */
    adminHold: boolean
    /** When it was deleted; it is purged at `purgesAt` unless restored. */
    deletedAt: string | null
    purgesAt: string | null
    /** Only when listed by `managedBy`. */
    handOver: HandOverFacts | null
}

export interface ServiceAccountRole {
    bindingId: string
    workspaceId: string
    workspaceName: string | null
    role: string
    grantedAt: string | null
    /** When it ends; null while it lasts until taken away. */
    expiresAt: string | null
}

/** A request for its access still waiting on a workspace. */
export interface ServiceAccountRequest {
    id: string
    workspaceId: string
    workspaceName: string | null
    role: string
    createdAt: string
    /** Who asked for it, by name. */
    requestedBy: string | null
    /** A request to keep this role, which ends soon. */
    bindingId: string | null
}

/** What you may do with one account, as the server decides it. */
export interface ServiceAccountCan {
    view: boolean
    /** Rename it, or say what it is for. */
    edit: boolean
    disable: boolean
    /** Its managers can't while an administrator holds it disabled. */
    enable: boolean
    /** Appoint and remove its managers. */
    managers: boolean
    /** Make, rotate and revoke its keys. */
    keys: boolean
    /** Give it workspace roles from its page. */
    grant: boolean
    /** Take its roles away. */
    revoke: boolean
    /** Ask a workspace for access for it, or to keep access that ends. */
    request: boolean
    /** Its keys stop at once; it can be restored for 30 days. */
    delete: boolean
    /** Its managers can't while an administrator holds it. */
    restore: boolean
}

export interface ServiceAccountDetail extends ServiceAccount {
    roles: ServiceAccountRole[]
    /** Requests for its access still waiting on a workspace. */
    requests: ServiceAccountRequest[]
    liveKeys: number
    can: ServiceAccountCan
}

export interface ServiceAccountList {
    items: ServiceAccount[]
    total: number
    /** How many days an account's keys keep working after its last manager goes. */
    graceDays: number
}

export interface ServiceAccountFilters {
    q?: string
    /** `deleted`: those deleted and not yet purged. */
    status?: 'active' | 'disabled' | 'deleted'
    /** No manager in good standing, or held by an administrator. */
    standing?: 'unmanaged' | 'held'
    /** A person, themselves or through a team, or a team. */
    manager?: string
    /** Holding a role in this workspace. */
    workspace?: string
    /** The accounts a person's leaving touches — those they manage, themselves or
     *  through a team, and those they made a key for that still works — with what
     *  it involves. */
    managedBy?: string
    limit?: number
    offset?: number
}

function query(params: object): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    const qs = search.toString()
    return qs ? `?${qs}` : ''
}

const one = (id: string) => `${ADMIN}/${encodeURIComponent(id)}`
const manager = (id: string, ref: ManagerRef) =>
    `${one(id)}/managers/${ref.type === 'user' ? 'users' : 'groups'}/${encodeURIComponent(ref.id)}`

export const serviceAccountService = {
    list(filters: ServiceAccountFilters = {}): Promise<ServiceAccountList> {
        return authFetch(`${ADMIN}${query(filters)}`)
    },

    /** For its managers, the administrators of service accounts, and anyone
     *  who may make any account's keys. */
    get(id: string): Promise<ServiceAccountDetail> {
        return authFetch(one(id))
    },

    /** At least one manager, a person or a team, from the start. */
    create(body: { name: string; description?: string; managers: ManagerRef[] }): Promise<ServiceAccountDetail> {
        return authFetch(ADMIN, { method: 'POST', body: JSON.stringify(body) })
    },

    update(id: string, body: { name?: string; description?: string | null }): Promise<ServiceAccountDetail> {
        return authFetch(one(id), { method: 'PATCH', body: JSON.stringify(body) })
    },

    /** Every key it holds stops at once; nothing is revoked. */
    disable(id: string): Promise<ServiceAccountDetail> {
        return authFetch(`${one(id)}/disable`, { method: 'POST' })
    },

    enable(id: string): Promise<ServiceAccountDetail> {
        return authFetch(`${one(id)}/enable`, { method: 'POST' })
    },

    /** Every key it holds stops at once; for 30 days restoring it brings it all back. */
    delete(id: string): Promise<ServiceAccountDetail> {
        return authFetch(one(id), { method: 'DELETE' })
    },

    restore(id: string): Promise<ServiceAccountDetail> {
        return authFetch(`${one(id)}/restore`, { method: 'POST' })
    },

    addManager(id: string, ref: ManagerRef): Promise<ServiceAccountDetail> {
        return authFetch(manager(id, ref), { method: 'PUT' })
    },

    removeManager(id: string, ref: ManagerRef): Promise<ServiceAccountDetail> {
        return authFetch(manager(id, ref), { method: 'DELETE' })
    },

    /** A workspace role that neither administers the workspace nor lets people in,
     *  until `expiresAt` or until taken away. */
    grantRole(id: string, body: { workspaceId: string; role: string; expiresAt?: string }): Promise<ServiceAccountRole> {
        return authFetch(`${one(id)}/roles`, { method: 'POST', body: JSON.stringify(body) })
    },

    revokeRole(id: string, bindingId: string): Promise<void> {
        return authFetch(`${one(id)}/roles/${encodeURIComponent(bindingId)}`, { method: 'DELETE' })
    },

    /** Move a person's manager seats to a successor — all of them, or `accountIds`. */
    handOver(body: { fromUserId: string; to: ManagerRef; accountIds?: string[] }): Promise<{ handedOver: string[] }> {
        return authFetch(`${ADMIN}/hand-over`, { method: 'POST', body: JSON.stringify(body) })
    },

    /** The accounts you manage, yourself or through a team, a page at a time —
     *  then those deleted and not yet purged. */
    mine(params: { limit?: number; offset?: number } = {}): Promise<ServiceAccountList> {
        return authFetch(`${MINE}${query(params)}`)
    },
}
