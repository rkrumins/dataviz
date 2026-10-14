/**
 * API keys — your own (Account → API keys), and everyone's (Administration).
 *
 * Minting a key (create, rotate) can be refused for a reason the page acts
 * on rather than shows: the session has to prove it is really you first
 * (`step_up_required`, with how), or cannot from this sign-in at all
 * (`step_up_unavailable`). So these calls keep the server's structured
 * refusal instead of flattening it to a message, and pass `silent403` — a
 * step-up 403 is part of this form, not an access denial.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

const MINE = '/api/v1/me/api-keys'
const ADMIN = '/api/v1/admin/api-keys'

export type Level = 'none' | 'read' | 'write'

export interface ApiKeyPermissions {
    views: Level
    data: Level
    publish: boolean
}

export interface ApiKeySelection {
    workspaces: string[]
    views: string[]
    dataSources: string[]
}

export type ApiKeyResources = 'all' | ApiKeySelection

export type ApiKeyStatus = 'active' | 'paused' | 'expired' | 'revoked' | 'owner_inactive' | 'ip_not_allowed'

export interface ApiKey {
    id: string
    name: string
    description: string | null
    prefix: string
    kind: string
    permissions: ApiKeyPermissions
    resources: ApiKeyResources
    allowedCidrs: string[]
    /** When it stops working; null = never. Includes the deployment's cap. */
    expiresAt: string | null
    status: ApiKeyStatus
    createdAt: string
    createdIp: string | null
    lastUsedAt: string | null
    lastUsedIp: string | null
    lastUsedUserAgent: string | null
    revokedAt: string | null
    revokedBy: string | null
    revokedReason: string | null
    /** An administrator's note to the owner, given when they revoked it. */
    revokedNote: string | null
    rotatedFrom: string | null
    usage: ApiKeyUsage
}

/** Calls made with a key: the last 30 days, and the last 14 by UTC day. */
export interface ApiKeyUsage {
    requests30d: number
    writes30d: number
    /** Refused because of the key: 401, 403 or 429. */
    refused30d: number
    /** Any other answer of 400 or above. */
    errors30d: number
    /** Requests per UTC day, oldest first; today last. */
    daily14: number[]
}

export interface UsageDay {
    /** YYYY-MM-DD, UTC. */
    day: string
    requests: number
    writes: number
    refused: number
    errors: number
}

/** The key one replaced, or the one that replaced it. */
export interface KeyRef {
    id: string
    name: string
    prefix: string
}

export interface WorkspaceAccess {
    id: string
    name: string
    views: Level
    data: Level
    publish: boolean
}

export interface ResourceAccess {
    id: string
    name: string | null
    workspaceId: string | null
    level: Level
}

/** What a key can do right now: its owner's access today, narrowed by the key. */
export interface EffectiveAccess {
    workspaces: WorkspaceAccess[]
    views: ResourceAccess[]
    dataSources: ResourceAccess[]
    /** Set when the key reaches every workspace through an organisation-wide
     *  role; `workspaces` is then not a list of them. */
    everyWorkspace: { views: Level; data: Level; publish: boolean } | null
}

export interface ApiKeyDetail extends ApiKey {
    effectiveAccess: EffectiveAccess
    /** 30 UTC days, oldest first. */
    usageDays: UsageDay[]
    replaces: KeyRef | null
    replacedBy: KeyRef | null
}

export type ApiKeyLastUse = Pick<ApiKey, 'lastUsedAt' | 'lastUsedIp' | 'lastUsedUserAgent'>

/** Why a sign-in cannot confirm a new key, when it cannot: its provider cannot
 *  confirm a fresh sign-in, or password sign-in is switched off. */
export type StepUpReason = 'provider' | 'passwords_off'

export interface ApiKeyOptions {
    policy: {
        enabled: boolean
        maxLifetimeDays: number | null
        ssoSignInWindowDays: number | null
        maxActiveKeys: number
    }
    stepUp: { method: 'password' | 'sso'; fresh: boolean }
    /** False: this session cannot prove it is you, and the deployment does not
     *  accept a fresh round trip instead — creating or rotating is refused. */
    stepUpAvailable: boolean
    /** Why not, when stepUpAvailable is false. */
    stepUpReason?: StepUpReason | null
    activeKeys: number
    workspaces: WorkspaceAccess[]
    /** The address the server sees this browser at. */
    clientIp: string | null
    /** Where someone whose keys are paused signs in to resume them. */
    ssoSignInUrl: string | null
}

export interface PickerItem {
    id: string
    name: string
    workspaceId: string
    workspaceName: string | null
    level: 'read' | 'write'
}

export interface Expiry {
    expiresAt?: string | null
    neverExpires?: boolean
}

export interface CreateApiKeyBody extends Expiry {
    name: string
    description?: string
    permissions: ApiKeyPermissions
    resources: ApiKeyResources
    allowedCidrs?: string[]
    currentPassword?: string
}

/** What creating would make, without making it. */
export type PreviewApiKeyBody = Omit<CreateApiKeyBody, 'currentPassword'>

export interface ApiKeyPreview {
    permissions: ApiKeyPermissions
    resources: ApiKeyResources
    allowedCidrs: string[]
    expiresAt: string | null
    effectiveAccess: EffectiveAccess
    activeKeys: number
    maxActiveKeys: number
}

export interface UpdateApiKeyBody {
    name?: string
    description?: string | null
}

export interface RotateApiKeyBody extends Expiry {
    graceSeconds: 0 | 3600 | 86400 | 604800
    currentPassword?: string
}

export interface CreatedApiKey {
    key: ApiKey
    /** The key itself. Shown once; it cannot be fetched again. */
    token: string
}

export interface AdminApiKey extends ApiKey {
    owner: {
        id: string
        email: string
        displayName: string
        /** For drawing their face: the picked illustration, and whether a picture is stored. */
        avatarId: string | null
        hasImage: boolean
        deleted: boolean
    }
}

export interface AdminApiKeyDetail extends AdminApiKey {
    effectiveAccess: EffectiveAccess
    usageDays: UsageDay[]
    replaces: KeyRef | null
    replacedBy: KeyRef | null
}

export type AdminKeyStatus = 'active' | 'paused' | 'owner_inactive' | 'expired' | 'revoked'
export type AdminKeyFocus = 'expiring_soon' | 'never_expires' | 'unused' | 'recently_revoked'
export type AdminKeySort = 'created' | 'lastUsed' | 'expires' | 'name'

/** The inventory's filters — the list, the export and (owner, search) the stats. */
export interface AdminKeyFilters {
    ownerId?: string
    status?: AdminKeyStatus
    focus?: AdminKeyFocus
    q?: string
    sort?: AdminKeySort
    order?: 'asc' | 'desc'
}

export interface AdminApiKeyStats {
    total: number
    byStatus: { active: number; paused: number; ownerInactive: number; expired: number; revoked: number }
    expiringSoon: number
    neverExpires: number
    unused90: number
    revoked30d: number
}

/** A refusal with the server's own code, and what the page needs to act on it. */
export class ApiKeyError extends Error {
    readonly status: number
    readonly code: string | null
    /** step_up_required: how to confirm it's you. */
    readonly method: 'password' | 'sso' | null
    /** step_up_required with method sso: where to sign in again. */
    readonly loginUrl: string | null
    /** step_up_unavailable: why this sign-in cannot confirm a key. */
    readonly reason: StepUpReason | null
    /** Selected resources the owner cannot give a key, by type. */
    readonly unknown: Partial<Record<keyof ApiKeySelection, string[]>> | null

    constructor(status: number, message: string, detail: Record<string, unknown> | null) {
        super(message)
        this.status = status
        this.code = typeof detail?.error === 'string' ? detail.error : null
        this.method = detail?.method === 'password' || detail?.method === 'sso' ? detail.method : null
        this.loginUrl = typeof detail?.loginUrl === 'string' ? detail.loginUrl : null
        this.reason = typeof detail?.reason === 'string' ? detail.reason as StepUpReason : null
        this.unknown = detail?.unknown && typeof detail.unknown === 'object'
            ? detail.unknown as ApiKeyError['unknown']
            : null
    }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
        silent403: true,
    })
    if (!res.ok) {
        const text = await res.text()
        let detail: Record<string, unknown> | null = null
        try {
            const parsed = JSON.parse(text) as { detail?: unknown }
            detail = parsed?.detail && typeof parsed.detail === 'object'
                ? parsed.detail as Record<string, unknown>
                : null
        } catch {
            // Not JSON — the message below still carries the status line.
        }
        const message = typeof detail?.message === 'string'
            ? detail.message
            : extractErrorMessageFromText(text, res.statusText)
        throw new ApiKeyError(res.status, message, detail)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
}

/** A query string of the values that are set. */
function query(params: object): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    return search.toString()
}

/** A note is sent only when there is one. */
function noteBody(note?: string): string {
    return JSON.stringify(note?.trim() ? { note: note.trim() } : {})
}

export const apiKeyService = {
    options(): Promise<ApiKeyOptions> {
        return call(`${MINE}/options`)
    },

    /** Live keys and those ended in the last 90 days; `all` for every one. */
    list(history?: 'all'): Promise<ApiKey[]> {
        return call(history ? `${MINE}?history=all` : MINE)
    },

    get(id: string, signal?: AbortSignal): Promise<ApiKeyDetail> {
        return call(`${MINE}/${encodeURIComponent(id)}`, { signal })
    },

    /** When and from where the key was last used, and nothing else: one read. */
    lastUse(id: string, signal?: AbortSignal): Promise<ApiKeyLastUse> {
        return call(`${MINE}/${encodeURIComponent(id)}/last-use`, { signal })
    },

    searchResources(
        type: 'view' | 'data_source', q: string, workspaceId?: string,
    ): Promise<PickerItem[]> {
        const params = new URLSearchParams({ type, limit: '20' })
        if (q.trim()) params.set('q', q.trim())
        if (workspaceId) params.set('workspaceId', workspaceId)
        return call(`${MINE}/resources?${params}`)
    },

    create(body: CreateApiKeyBody): Promise<CreatedApiKey> {
        return call(MINE, { method: 'POST', body: JSON.stringify(body) })
    },

    preview(body: PreviewApiKeyBody, signal?: AbortSignal): Promise<ApiKeyPreview> {
        return call(`${MINE}/preview`, { method: 'POST', body: JSON.stringify(body), signal })
    },

    /** Name and description only: what a key may do is fixed when it is made. */
    update(id: string, body: UpdateApiKeyBody): Promise<ApiKey> {
        return call(`${MINE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
    },

    rotate(id: string, body: RotateApiKeyBody): Promise<CreatedApiKey> {
        return call(`${MINE}/${encodeURIComponent(id)}/rotate`, {
            method: 'POST', body: JSON.stringify(body),
        })
    },

    revoke(id: string): Promise<void> {
        return call(`${MINE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    adminList(params: AdminKeyFilters & { limit?: number; offset?: number }): Promise<{ items: AdminApiKey[]; total: number }> {
        return call(`${ADMIN}?${query(params)}`)
    },

    adminStats(params: { ownerId?: string; q?: string }): Promise<AdminApiKeyStats> {
        return call(`${ADMIN}/stats?${query(params)}`)
    },

    adminGet(id: string): Promise<AdminApiKeyDetail> {
        return call(`${ADMIN}/${encodeURIComponent(id)}`)
    },

    /** The note (up to 500 characters) is shown to the owner. */
    adminRevoke(id: string, note?: string): Promise<void> {
        return call(`${ADMIN}/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: noteBody(note) })
    },

    adminRevokeAll(userId: string, note?: string): Promise<{ revoked: number }> {
        return call(`/api/v1/admin/users/${encodeURIComponent(userId)}/api-keys/revoke-all`, {
            method: 'POST', body: noteBody(note),
        })
    },

    /** The inventory as CSV, with the same filters and order — for a plain link. */
    adminExportUrl(filters: AdminKeyFilters): string {
        return `${ADMIN}/export.csv?${query(filters)}`
    },
}
