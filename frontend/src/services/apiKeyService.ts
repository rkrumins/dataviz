/**
 * API keys — your own (Account → API keys), and everyone's (Administration).
 *
 * Minting a key (create, rotate) can be refused for a reason the page acts
 * on rather than shows: the session has to prove it is really you first
 * (`step_up_required`, with how). So these calls keep the server's
 * structured refusal instead of flattening it to a message, and pass
 * `silent403` — a step-up 403 is part of this form, not an access denial.
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
    rotatedFrom: string | null
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

export interface ApiKeyDetail extends ApiKey {
    effectiveAccess: {
        workspaces: WorkspaceAccess[]
        views: ResourceAccess[]
        dataSources: ResourceAccess[]
    }
}

export interface ApiKeyOptions {
    policy: {
        enabled: boolean
        maxLifetimeDays: number | null
        ssoSignInWindowDays: number | null
        maxActiveKeys: number
    }
    stepUp: { method: 'password' | 'sso'; fresh: boolean }
    activeKeys: number
    workspaces: WorkspaceAccess[]
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
    owner: { id: string; email: string; displayName: string }
}

/** A refusal with the server's own code, and what the page needs to act on it. */
export class ApiKeyError extends Error {
    readonly status: number
    readonly code: string | null
    /** step_up_required: how to confirm it's you. */
    readonly method: 'password' | 'sso' | null
    /** step_up_required with method sso: where to sign in again. */
    readonly loginUrl: string | null
    /** Selected resources the owner cannot give a key, by type. */
    readonly unknown: Partial<Record<keyof ApiKeySelection, string[]>> | null

    constructor(status: number, message: string, detail: Record<string, unknown> | null) {
        super(message)
        this.status = status
        this.code = typeof detail?.error === 'string' ? detail.error : null
        this.method = detail?.method === 'password' || detail?.method === 'sso' ? detail.method : null
        this.loginUrl = typeof detail?.loginUrl === 'string' ? detail.loginUrl : null
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

export const apiKeyService = {
    options(): Promise<ApiKeyOptions> {
        return call(`${MINE}/options`)
    },

    list(): Promise<ApiKey[]> {
        return call(MINE)
    },

    get(id: string): Promise<ApiKeyDetail> {
        return call(`${MINE}/${encodeURIComponent(id)}`)
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

    rotate(id: string, body: RotateApiKeyBody): Promise<CreatedApiKey> {
        return call(`${MINE}/${encodeURIComponent(id)}/rotate`, {
            method: 'POST', body: JSON.stringify(body),
        })
    },

    revoke(id: string): Promise<void> {
        return call(`${MINE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    adminList(params: {
        ownerId?: string
        status?: 'active' | 'expired' | 'revoked'
        unusedDays?: number
        q?: string
        limit?: number
        offset?: number
    }): Promise<{ items: AdminApiKey[]; total: number }> {
        const search = new URLSearchParams()
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== '') search.set(key, String(value))
        }
        return call(`${ADMIN}?${search}`)
    },

    adminRevoke(id: string): Promise<void> {
        return call(`${ADMIN}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    adminRevokeAll(userId: string): Promise<{ revoked: number }> {
        return call(`/api/v1/admin/users/${encodeURIComponent(userId)}/api-keys/revoke-all`, {
            method: 'POST',
        })
    },
}
