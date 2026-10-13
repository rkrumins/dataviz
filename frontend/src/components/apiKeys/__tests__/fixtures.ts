/** Keys, options and details as the server sends them, for the API key tests. */
import type {
    AdminApiKey, ApiKey, ApiKeyDetail, ApiKeyOptions, ApiKeyUsage, EffectiveAccess,
} from '@/services/apiKeyService'

export const usage = (over: Partial<ApiKeyUsage> = {}): ApiKeyUsage => ({
    requests30d: 0, writes30d: 0, refused30d: 0, errors30d: 0, daily14: Array(14).fill(0), ...over,
})

export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

export function apiKey(over: Partial<ApiKey> = {}): ApiKey {
    return {
        id: 'apk_1', name: 'nightly sync', description: null, prefix: 'nxpat_AbCdEfGh', kind: 'personal',
        permissions: { views: 'read', data: 'write', publish: false },
        resources: { workspaces: [], views: ['v1'], dataSources: ['ds1', 'ds2'] },
        allowedCidrs: [], expiresAt: '2030-01-01T00:00:00+00:00', status: 'active',
        createdAt: '2026-10-01T00:00:00+00:00', createdIp: null,
        lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null,
        revokedAt: null, revokedBy: null, revokedReason: null, revokedNote: null, rotatedFrom: null,
        usage: usage(),
        ...over,
    }
}

export function adminKey(over: Partial<AdminApiKey> = {}): AdminApiKey {
    return {
        ...apiKey(),
        name: 'etl',
        owner: {
            id: 'usr_1', email: 'dana@example.com', displayName: 'Dana',
            avatarId: null, hasImage: false, deleted: false,
        },
        ...over,
    }
}

export const access = (over: Partial<EffectiveAccess> = {}): EffectiveAccess => ({
    workspaces: [{ id: 'ws1', name: 'Finance', views: 'read', data: 'write', publish: false }],
    views: [], dataSources: [], everyWorkspace: null, ...over,
})

export function detail(over: Partial<ApiKeyDetail> = {}): ApiKeyDetail {
    return {
        ...apiKey(),
        effectiveAccess: access(),
        usageDays: [],
        replaces: null,
        replacedBy: null,
        ...over,
    }
}

export function options(over: Partial<ApiKeyOptions> = {}): ApiKeyOptions {
    return {
        policy: { enabled: true, maxLifetimeDays: null, ssoSignInWindowDays: 30, maxActiveKeys: 25 },
        stepUp: { method: 'password', fresh: false },
        stepUpAvailable: true,
        activeKeys: 1,
        workspaces: [{ id: 'ws1', name: 'Finance', views: 'write', data: 'read', publish: false }],
        clientIp: '203.0.113.24',
        ssoSignInUrl: '/api/v1/auth/corp/login?next=/me/api-keys',
        ...over,
    }
}
