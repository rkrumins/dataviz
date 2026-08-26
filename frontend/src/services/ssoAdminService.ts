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
export type IdpKind =
    | 'oidc' | 'saml2' | 'custom' | 'custom_profile' | 'backchannel'

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

/** Typed view of a ``backchannel`` row's settings blob. Optional
 *  throughout for the same reason as above: the form builds it up and
 *  the server owns validation. ``gateway_headers`` / ``exchange_headers``
 *  come back redacted as a whole — we cannot know which of an
 *  operator's own header names carries the credential. */
export interface BackchannelSettings {
    token_source?: 'cookie' | 'header'
    token_source_key?: string
    gateway_url?: string
    gateway_method?: 'POST' | 'GET'
    gateway_send_as?: 'cookie' | 'header' | 'body'
    gateway_token_header?: string
    gateway_token_prefix?: string
    gateway_body_field?: string
    gateway_headers?: Record<string, string>
    gateway_token_path?: string
    exchange_url?: string
    exchange_method?: 'POST' | 'GET'
    exchange_send_as?: 'body' | 'header'
    exchange_body_field?: string
    exchange_token_header?: string
    exchange_token_prefix?: string
    exchange_headers?: Record<string, string>
    exchange_claims_path?: string
    timeout_seconds?: number
    require_auth_time?: boolean
    liveness_on_refresh?: boolean
    liveness_grace_seconds?: number
}

/** One permitted internal destination for a back-channel provider.
 *  Platform-level rather than per-provider: a per-provider allowlist
 *  would be circular. Managed under ``system:sso:hosts:manage``. */
export interface BackchannelHost {
    id: string
    host: string
    port: number
    note?: string | null
    createdAt?: string | null
    createdBy?: string | null
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
        /** The full-name string as the IdP released it; absent on older
         *  servers. */
        display_name?: string | null
        avatar_url?: string | null
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
    /**
     * The claim `first_name`/`last_name` were split out of, when the IdP
     * released one full name instead of naming the halves. Null otherwise.
     *
     * Both names are populated in that case but `resolvedFrom` reports
     * `null` for each — correctly, since none of *their* candidates
     * matched — so this is what tells the two apart.
     */
    namesDerivedFrom?: string | null
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

/** Outcome of an end-sessions call. With ``dryRun`` nothing was written
 *  and ``usersAffected`` is the count a confirm dialog shows; without it
 *  the numbers are what actually happened. */
export interface EndSessionsResult {
    /** Absent on the platform-wide sweep. */
    providerId?: string
    usersAffected: number
    tokensRevoked: number
    dryRun: boolean
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

/** What a back-channel rehearsal reports — the dry-run envelope from
 *  ``preview_sso_login``, snake_case as the server writes it. */
export interface RehearsalOutcome {
    action?: string
    reason?: string
    deny_reasons?: string[]
    email?: string
    external_id?: string
    user_email?: string
    groups?: string[]
    reconcile?: {
        matched?: {
            idp_group?: string
            target_type?: string
            role_name?: string | null
            group_id?: string | null
            scope_type?: string | null
            scope_id?: string | null
        }[]
        unmatched_groups?: string[]
    }
    /** Browser-assertion rehearsals only: which case the gateway's
     *  reply turned out to be, and what judged it. Absent for handle
     *  and server rehearsals. */
    verification?: {
        shape?: 'jwt' | 'json'
        verified?: boolean
        material?: 'jwks' | 'public_key' | 'shared_secret' | 'none'
    }
    /** Whether the claims carried a usable authentication time, and the
     *  re-certification ceiling measured against it. Absent from older
     *  servers — absent means say nothing. */
    auth_time?: { present?: boolean; ceiling_hours?: number }
}

/** The verification verdict as one operator-readable line, or null when
 *  the outcome carries none (handle/server rehearsals). */
function verificationLine(
    v: NonNullable<RehearsalOutcome['verification']>,
): string {
    if (v.verified) {
        const material = v.material === 'public_key'
            ? 'your pasted public key'
            : v.material === 'shared_secret'
                ? 'the shared secret'
                : "the connection's published keys (JWKS)"
        return `The reply was a signed token, verified against ${material}.`
    }
    return v.shape === 'json'
        ? 'The reply was unsigned JSON, accepted only because Trust '
          + 'unsigned is on — this connection is rated Unverified.'
        : 'The reply was a signed token accepted WITHOUT verification '
          + 'because Trust unsigned is on — this connection is rated '
          + 'Unverified.'
}

/** The rehearsal's group story, as lines an operator can read.
 *
 *  The whole point of rehearsing is answering "what would this sign-in
 *  DO" — and the outcome's groups and matched mappings are exactly the
 *  part operators are debugging when access doesn't appear. Discarding
 *  them made the rehearsal say only who, never what.
 */
export function summarizeRehearsalOutcome(outcome: RehearsalOutcome): string[] {
    const lines: string[] = []
    if (outcome.verification) {
        // First, because it answers the question a varying gateway
        // makes operators ask: which case did we just see, and was it
        // verified?
        lines.push(verificationLine(outcome.verification))
    }
    if (outcome.auth_time?.present === false) {
        // Only a requirement-off row reaches a verdict without one —
        // and then the ceiling quietly measures from each sign-in.
        lines.push(
            'The claims carried no authentication time — the '
            + `${outcome.auth_time.ceiling_hours ?? 24}-hour `
            + 're-certification will measure from each sign-in instead '
            + 'of from the IdP.',
        )
    }
    const groups = outcome.groups ?? []
    lines.push(
        groups.length
            ? `Groups asserted: ${groups.join(', ')}.`
            : 'The claims carried no groups.',
    )
    const matched = outcome.reconcile?.matched ?? []
    if (matched.length) {
        const described = matched.map((m) =>
            m.target_type === 'group_membership'
                ? `${m.idp_group} → group membership`
                : `${m.idp_group} → ${m.role_name ?? 'role'}${
                    m.scope_type === 'workspace' && m.scope_id
                        ? ` in workspace ${m.scope_id}`
                        : ''
                }`,
        )
        lines.push(`Mappings that would apply: ${described.join('; ')}.`)
    } else if (groups.length) {
        lines.push('No group mapping matched — nothing would be granted.')
    }
    const unmatched = outcome.reconcile?.unmatched_groups ?? []
    if (unmatched.length && matched.length) {
        lines.push(`Groups matching no mapping: ${unmatched.join(', ')}.`)
    }
    if (outcome.action === 'rejected' && outcome.deny_reasons?.length) {
        lines.push(`Refused because: ${outcome.deny_reasons.join(', ')}.`)
    }
    return lines
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

    // ── Back-channel host allowlist ──────────────────────────────────
    //
    // Which internal addresses a back-channel provider may call. Gated
    // server-side on ``system:sso:hosts:manage`` rather than
    // ``system:admin``, so these three can 403 for someone who can edit
    // every other thing on this page — the UI has to say so rather than
    // showing an empty list.

    listBackchannelHosts(): Promise<BackchannelHost[]> {
        return request<BackchannelHost[]>(
            `${ADMIN}/idp-providers/backchannel-hosts`,
        )
    },

    addBackchannelHost(
        body: { host: string; port?: number; note?: string },
    ): Promise<BackchannelHost> {
        return request<BackchannelHost>(
            `${ADMIN}/idp-providers/backchannel-hosts`,
            { method: 'POST', body: JSON.stringify(body) },
        )
    },

    deleteBackchannelHost(id: string): Promise<void> {
        return request<void>(
            `${ADMIN}/idp-providers/backchannel-hosts/${encodeURIComponent(id)}`,
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

    /** End every session this connection minted — or, with ``dryRun``,
     *  just count who that would sign out. Password sessions are never
     *  touched, so "switch back to local accounts" starts immediately.
     *  Works whether the row is enabled or not: the usual moment for
     *  this is right after turning it off. */
    endProviderSessions(
        id: string, opts?: { dryRun?: boolean },
    ): Promise<EndSessionsResult> {
        return request<EndSessionsResult>(
            `${ADMIN}/idp-providers/${encodeURIComponent(id)}/end-sessions`,
            {
                method: 'POST',
                body: JSON.stringify({ dryRun: opts?.dryRun ?? false }),
            },
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

    /** Complete a back-channel rehearsal inline — the shapes that have
     *  nothing for an opened tab to carry (a handle, a browser-mode
     *  assertion). Call after ``startDryRun`` so the marker cookie rides
     *  along; the server answers the would-be outcome and writes
     *  nothing. Returns a line to show the operator either way — the
     *  verdict of a rehearsal is a result, not an error. */
    async rehearseBackchannel(
        slug: string, body: { handle?: string; assertion?: string },
    ): Promise<{ ok: boolean; line: string; outcome?: RehearsalOutcome }> {
        const res = await fetchWithTimeout(
            `/api/v1/auth/${encodeURIComponent(slug)}/backchannel`,
            {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                skipAuthRefresh: true,
            },
        )
        const payload = await res.json().catch(() => null)
        if (!res.ok) {
            return {
                ok: false,
                line: `Rehearsal failed: ${
                    payload?.detail?.error ?? res.status
                }`,
            }
        }
        const outcome = payload?.outcome as RehearsalOutcome | undefined
        if (!outcome) {
            return { ok: true, line: 'Rehearsal completed, but reported nothing.' }
        }
        return {
            ok: true,
            // The envelope is snake_case — reading ``externalId`` here
            // used to make a subject with no email an "unnamed identity".
            line: `Rehearsal: would sign in as ${
                outcome.email ?? outcome.external_id ?? 'an unnamed identity'
            } (${outcome.action ?? 'no action recorded'}).`,
            outcome,
        }
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

    /** The master-switch companion to ``endProviderSessions``: end every
     *  session minted through any connection at once. Deliberately
     *  callable with ``ssoEnabled`` already off — that is when an
     *  operator reaches for it. */
    endSsoSessions(opts?: { dryRun?: boolean }): Promise<EndSessionsResult> {
        return request<EndSessionsResult>(
            `${ADMIN}/sso/config/end-sso-sessions`,
            {
                method: 'POST',
                body: JSON.stringify({ dryRun: opts?.dryRun ?? false }),
            },
        )
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
