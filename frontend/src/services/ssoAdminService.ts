/**
 * Admin-side SSO API client. Backs the ``Admin → SSO`` pages.
 *
 * All endpoints require ``system:admin`` server-side; the route guard
 * in ``RequirePermission`` keeps the UI hidden from non-admins.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

const ADMIN = '/api/v1/admin'

/** Provider kinds the backend accepts — mirrors ``VALID_KINDS`` in
 *  ``idp_provider_repo`` and the ``ck_idp_providers_kind`` CHECK. */
export type IdpKind = 'oidc' | 'saml2' | 'custom' | 'custom_profile'

/** How much a provider's word is worth — derived server-side from kind +
 *  settings on every read, never stored. Ordered worst to best. */
export type AssuranceLevel = 'unverified' | 'asserted' | 'verified'

/** Where a ``custom_profile`` row reads its payload from. Cookie and
 *  header are read server-side; the two storage sources need the
 *  browser to read the key and POST it. */
export type CustomProfileSource =
    | 'cookie' | 'local_storage' | 'session_storage' | 'header'

/** Typed view of a ``custom_profile`` row's settings blob. Every field
 *  is optional because the admin form builds it up incrementally and
 *  the server owns validation. */
export interface CustomProfileSettings {
    source?: CustomProfileSource
    source_key?: string
    encoding?: 'none' | 'base64url' | 'url'
    payload_format?: 'jwt' | 'json'
    trust_unsigned?: boolean
    signing_alg?: 'HS256' | 'RS256'
    shared_secret?: string
    public_key?: string
    issuer?: string
    audience?: string
    max_age_seconds?: number
    trusted_proxy_acknowledged?: boolean
}

export interface IdpProvider {
    id: string
    slug: string
    displayName: string
    kind: IdpKind
    enabled: boolean
    priority: number
    settings: Record<string, unknown>     // secrets redacted as '********'
    claimMapping: Record<string, unknown>
    linkingPolicy: 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    buttonLabel?: string | null
    buttonIcon?: string | null
    /** Derived server-side; see AssuranceLevel. */
    assurance: AssuranceLevel
    /** One-line operator explanation of what that level means. */
    assuranceReason: string
    /** Domains routed here when email-first login is on. */
    emailDomains: string[]
    /** When an assertion was last captured, or null. */
    lastAssertionAt?: string | null
    /** Readiness. A ``draft`` is configured but unproven and reaches no
     *  public surface; ``live`` is on the login page. Distinct from
     *  ``enabled``, which is the operational switch. */
    lifecycle?: 'draft' | 'live'
    createdAt: string
    updatedAt: string
}

export interface CreateProviderInput {
    slug: string
    displayName: string
    kind: IdpKind
    settings?: Record<string, unknown>
    claimMapping?: Record<string, unknown>
    linkingPolicy?: 'strict' | 'allow_verified' | 'manual_only' | 'disabled'
    priority?: number
    enabled?: boolean
    buttonLabel?: string
    buttonIcon?: string
    emailDomains?: string[]
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
    emailDomains?: string[]
}

export interface IdpHealth {
    providerId: string
    slug: string
    /** ok | warning | unavailable | unknown. ``unknown`` means the sweep has
     *  not run or the kind has nothing to probe — never "broken". */
    status: string
    detail?: string | null
    certNotAfter?: string | null
    certDaysRemaining?: number | null
    checkedAt?: string | null
}

export interface DiscoverInput {
    kind: IdpKind
    /** OIDC: the issuer URL. */
    issuer?: string
    /** SAML: a metadata URL to fetch, or… */
    metadataUrl?: string
    /** …the metadata XML pasted directly. */
    metadataXml?: string
}

export interface DiscoverResult {
    success: boolean
    /** Settings to merge into the form. Never contains secrets — the
     *  operator still supplies client_id / client_secret themselves. */
    settings: Record<string, unknown>
    /** Endpoints read from the discovery document, for display. */
    metadata: Record<string, unknown>
    /** Non-fatal findings worth showing before the operator saves. */
    warnings: string[]
    error?: string | null
}

export interface TestMappingResult {
    /** Absent on the provider-less preview — there is no row to name. */
    providerId?: string
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
    /**
     * Which candidate key actually supplied each field, keyed by our field
     * name plus `extras.<name>`. `null` means nothing in the list matched.
     *
     * Computed server-side against the same walker that runs at login —
     * the fallback list is ordered and dotted paths are real, so a
     * client-side guess would be free to disagree with the sign-in that
     * eventually happens.
     */
    resolvedFrom?: Record<string, string | null>
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
    emailFirstLogin: boolean
    version: number
    updatedAt: string
}

export interface AuthConfigPatch {
    ssoEnabled?: boolean
    allowLocalLogin?: boolean
    allowJitProvisioning?: boolean
    emailFirstLogin?: boolean
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

    /** Promote a draft to live — the moment it appears on the login page
     *  for every user. Deliberately its own call, not a PATCH: making a
     *  provider public is a different kind of act from renaming it. */
    publishProvider(id: string): Promise<IdpProvider> {
        return request<IdpProvider>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}/publish`,
            { method: 'POST' },
        )
    },

    /** Begin a rehearsal sign-in. Sets the marker cookie and returns the
     *  IdP login URL to open; the callback reports the would-be outcome
     *  and writes nothing. */
    startDryRun(id: string): Promise<{ loginUrl: string; expiresInMinutes: number }> {
        return request<{ loginUrl: string; expiresInMinutes: number }>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}/dry-run/start`,
            { method: 'POST' },
        )
    },

    /** The most recent assertion a provider sent, for mapping against
     *  reality rather than a hand-typed sample. 404s until one is captured. */
    lastAssertion(id: string): Promise<{ claims: Record<string, unknown>; capturedAt: string }> {
        return request<{ claims: Record<string, unknown>; capturedAt: string }>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}/last-assertion`,
        )
    },

    /** Last known IdP health from the background sweep. Reads a cache —
     *  makes no outbound requests, so it is safe to poll. */
    providerStatus(): Promise<{ providers: IdpHealth[] }> {
        return request<{ providers: IdpHealth[] }>(
            `${ADMIN}/idp-providers/status`,
        )
    },

    /**
     * Read a provider's own published configuration and derive its settings.
     *
     * Resolves even when the probe fails — the failure is in
     * ``result.error``, not an exception, matching the backend contract.
     * Only a malformed request rejects.
     */
    discover(body: DiscoverInput): Promise<DiscoverResult> {
        return request<DiscoverResult>(`${ADMIN}/idp-providers/discover`, {
            method: 'POST', body: JSON.stringify(body),
        })
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

    /**
     * Resolve a mapping that has no provider row behind it yet.
     *
     * `testMapping` needs a saved id, which the setup wizard does not have
     * at its mapping step — the draft is created one step later. That made
     * preview dead exactly where a mapping is being written.
     */
    previewMapping(
        kind: IdpKind,
        claims: Record<string, unknown>,
        override?: Record<string, unknown>,
        slug?: string,
    ): Promise<TestMappingResult> {
        return request<TestMappingResult>(
            `${ADMIN}/idp-providers/preview-mapping`,
            {
                method: 'POST',
                body: JSON.stringify({ kind, claims, override, slug }),
            },
        )
    },

    getDefaultMapping(kind: IdpKind): Promise<Record<string, unknown>> {
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
