/**
 * Admin-side SSO API client. Backs the ``Admin → SSO`` pages.
 *
 * All endpoints require ``system:admin`` server-side; the route guard
 * in ``RequirePermission`` keeps the UI hidden from non-admins.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

const ADMIN = '/api/v1/admin'

export interface IdpProvider {
    id: string
    slug: string
    displayName: string
    kind: 'oidc' | 'saml2' | 'custom'
    enabled: boolean
    priority: number
    settings: Record<string, unknown>     // secrets redacted as '********'
    claimMapping: Record<string, unknown>
    linkingPolicy: 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    buttonLabel?: string | null
    buttonIcon?: string | null
    createdAt: string
    updatedAt: string
}

export interface CreateProviderInput {
    slug: string
    displayName: string
    kind: 'oidc' | 'saml2' | 'custom'
    settings?: Record<string, unknown>
    claimMapping?: Record<string, unknown>
    linkingPolicy?: 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    priority?: number
    enabled?: boolean
    buttonLabel?: string
    buttonIcon?: string
}

export interface UpdateProviderInput {
    displayName?: string
    enabled?: boolean
    priority?: number
    settings?: Record<string, unknown>
    claimMapping?: Record<string, unknown>
    linkingPolicy?: 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    buttonLabel?: string | null
    buttonIcon?: string | null
}

export interface TestMappingResult {
    providerId: string
    providerSlug: string
    resolved: {
        external_id: string
        email: string
        first_name: string
        last_name: string
        groups: string[]
        auth_time: number | null
        attributes: Record<string, unknown>
    }
}

export interface IdpGroupMapping {
    id: string
    providerId?: string | null
    idpGroup: string
    targetType: 'role_binding' | 'group_membership'
    // role_binding fields
    scopeType?: string | null
    scopeId?: string | null
    roleName?: string | null
    // group_membership field
    targetGroupId?: string | null
    createdAt: string
    createdBy?: string | null
}


// ── Phase 4: platform SSO posture (master toggle + local-login + JIT) ─


export interface AuthConfig {
    ssoEnabled: boolean
    allowLocalLogin: boolean
    allowJitProvisioning: boolean
    version: number
    updatedAt: string
}

export interface AuthConfigPatch {
    ssoEnabled?: boolean
    allowLocalLogin?: boolean
    allowJitProvisioning?: boolean
    expectedVersion?: number
}


// ── Phase 4: user lookup + search response shapes ───────────────────


export interface ProviderRef {
    id: string
    slug: string
    displayName: string
    kind: string
}

export interface UserIdentityRef {
    id: string
    provider: ProviderRef
    externalId: string
    emailAtLink?: string | null
    createdAt: string
    lastLoginAt?: string | null
}

export interface UserAttributeRef {
    key: string
    value: string
    sourceProvider?: ProviderRef | null
    setAt: string
}

export interface UserSummary {
    id: string
    email: string
    firstName: string
    lastName: string
    status: string
    signupSource: string                      // 'local_signup' | 'sso_jit' | ...
    signupProvider?: ProviderRef | null
    signupAt: string
    passwordSet: boolean
    identities: UserIdentityRef[]
    attributes: UserAttributeRef[]
    matchedOn?: string[] | null
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        // Use the shared extractor so structured permission /
        // validation envelopes land as readable strings instead of
        // "[object Object]" via ``new Error(dict)`` coercion.
        const detail = extractErrorMessageFromText(text, res.statusText)
        throw new Error(detail)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}


export const ssoAdminService = {
    // ── IdP providers ────────────────────────────────────────────────

    listProviders(): Promise<IdpProvider[]> {
        return request<IdpProvider[]>(`${ADMIN}/idp-providers`)
    },

    createProvider(body: CreateProviderInput): Promise<IdpProvider> {
        return request<IdpProvider>(`${ADMIN}/idp-providers`, {
            method: 'POST', body: JSON.stringify(body),
        })
    },

    updateProvider(id: string, body: UpdateProviderInput): Promise<IdpProvider> {
        return request<IdpProvider>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}`,
            { method: 'PATCH', body: JSON.stringify(body) },
        )
    },

    deleteProvider(id: string): Promise<void> {
        return request<void>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
        )
    },

    /** Dry-run claim mapping against a paste-in claims blob. */
    testMapping(
        id: string,
        claims: Record<string, unknown>,
        override?: Record<string, unknown>,
    ): Promise<TestMappingResult> {
        return request<TestMappingResult>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}/test`,
            { method: 'POST', body: JSON.stringify({ claims, override }) },
        )
    },

    getDefaultMapping(kind: 'oidc' | 'saml2' | 'custom'): Promise<Record<string, unknown>> {
        return request<Record<string, unknown>>(
            `${ADMIN}/idp-providers/defaults/${encodeURIComponent(kind)}`,
        )
    },

    // ── Group mappings ───────────────────────────────────────────────

    listGroupMappings(params?: {
        providerId?: string
        idpGroup?: string
        targetType?: string
    }): Promise<IdpGroupMapping[]> {
        const qs = new URLSearchParams()
        if (params?.providerId) qs.set('providerId', params.providerId)
        if (params?.idpGroup) qs.set('idpGroup', params.idpGroup)
        if (params?.targetType) qs.set('targetType', params.targetType)
        const q = qs.toString()
        return request<IdpGroupMapping[]>(
            `${ADMIN}/idp-group-mappings${q ? `?${q}` : ''}`,
        )
    },

    createRoleBindingMapping(body: {
        providerId?: string | null
        idpGroup: string
        roleName: string
        scopeType: 'global' | 'workspace'
        scopeId?: string | null
    }): Promise<IdpGroupMapping> {
        return request<IdpGroupMapping>(
            `${ADMIN}/idp-group-mappings/role-binding`,
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    createGroupMembershipMapping(body: {
        providerId?: string | null
        idpGroup: string
        targetGroupId: string
    }): Promise<IdpGroupMapping> {
        return request<IdpGroupMapping>(
            `${ADMIN}/idp-group-mappings/group-membership`,
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    deleteMapping(id: string): Promise<void> {
        return request<void>(
            `${ADMIN}/idp-group-mappings/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
        )
    },

    // ── Phase 4: app auth config ──────────────────────────────────────

    getAuthConfig(): Promise<AuthConfig> {
        return request<AuthConfig>(`${ADMIN}/sso/config`)
    },

    updateAuthConfig(patch: AuthConfigPatch): Promise<AuthConfig> {
        return request<AuthConfig>(`${ADMIN}/sso/config`, {
            method: 'PATCH', body: JSON.stringify(patch),
        })
    },

    // ── Phase 4: user lookup + search ────────────────────────────────

    lookupUserByEmail(email: string): Promise<UserSummary> {
        const qs = new URLSearchParams({ mode: 'email', value: email })
        return request<UserSummary>(`${ADMIN}/users/lookup?${qs.toString()}`)
    },

    lookupUserByIdentity(
        providerSlug: string, externalId: string,
    ): Promise<UserSummary> {
        const qs = new URLSearchParams({
            mode: 'identity', providerSlug, externalId,
        })
        return request<UserSummary>(`${ADMIN}/users/lookup?${qs.toString()}`)
    },

    lookupUserByAttribute(
        attributeKey: string, attributeValue: string,
    ): Promise<UserSummary> {
        const qs = new URLSearchParams({
            mode: 'attribute', attributeKey, attributeValue,
        })
        return request<UserSummary>(`${ADMIN}/users/lookup?${qs.toString()}`)
    },

    searchUsers(q: string, limit = 20): Promise<UserSummary[]> {
        const qs = new URLSearchParams({ q, limit: String(limit) })
        return request<UserSummary[]>(`${ADMIN}/users/search?${qs.toString()}`)
    },
}
