/**
 * What we know about the identity providers people actually run.
 *
 * The old form asked "kind?" and offered `oidc | saml2 | custom_profile |
 * custom`. That is our word for it. The operator's word is "Entra ID",
 * and they know their tenant, not our taxonomy — so the wizard asks which
 * product they use and derives the kind from that.
 *
 * Each preset carries four things the operator would otherwise have to
 * find out the hard way:
 *
 *   claimMapping  the claim names THAT vendor actually emits. Entra sends
 *                 `preferred_username`, Okta sends `email`, ADFS sends
 *                 schemas.xmlsoap.org URIs. Getting this wrong is the most
 *                 common reason a working connection produces broken users.
 *   sampleClaims  a worked example in that vendor's shape, so the live
 *                 preview has something real to chew on before a first
 *                 sign-in has happened.
 *   consoleSteps  what to do in THEIR console. Connecting an IdP is a
 *                 two-sided job and the page never acknowledged the other
 *                 side; `{{redirectUri}}` and friends are substituted with
 *                 this deployment's real values so they can be copied.
 *   docsUrl       the vendor's own page, for the parts we should not
 *                 restate and cannot keep current.
 *
 * A preset whose `claimMapping` cannot resolve its own `sampleClaims` is
 * worse than no preset — it teaches the wrong claim names with authority.
 * `vendorPresets.test.ts` asserts every one of them round-trips.
 */
import type { IdpKind } from '@/services/ssoAdminService'

export interface ConsoleStep {
    /** Imperative, second person: "Add a redirect URI". */
    title: string
    /** One line of why, when the reason is not obvious from the title. */
    detail?: string
    /** A value from this deployment the operator must paste over there.
     *  Rendered with a copy button. */
    copyValue?: 'redirectUri' | 'acsUrl' | 'entityId' | 'metadataUrl'
}

export interface VendorPreset {
    id: string
    name: string
    /** One line under the tile. What this is, in the operator's terms. */
    blurb: string
    kind: IdpKind
    /** Shown in the connect step's input. */
    connectHint?: string
    connectLabel?: string
    claimMapping: Record<string, string[]>
    sampleClaims: Record<string, unknown>
    consoleSteps: ConsoleStep[]
    docsUrl?: string
    /** Ordering on the picker grid. Lower first. */
    weight: number
}

// ── OIDC family ──────────────────────────────────────────────────────

const ENTRA: VendorPreset = {
    id: 'entra',
    name: 'Microsoft Entra ID',
    blurb: 'Formerly Azure AD. Most Microsoft 365 tenants.',
    kind: 'oidc',
    connectLabel: 'Tenant issuer URL',
    connectHint: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
    claimMapping: {
        external_id: ['oid', 'sub'],
        // Entra's `email` is only present when a mail attribute is set;
        // `preferred_username` is the UPN and is always there. Order
        // matters — first non-empty wins.
        email: ['email', 'preferred_username', 'upn'],
        email_verified: ['email_verified'],
        first_name: ['given_name'],
        last_name: ['family_name'],
        groups: ['groups', 'roles', 'wids'],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        oid: '00000000-1111-2222-3333-444444444444',
        sub: 'AAAAAAAAAAAAAAAAAAAAAA',
        preferred_username: 'ada.lovelace@corp.example',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        groups: ['11111111-2222-3333-4444-555555555555'],
        auth_time: 1769000000,
        tid: '99999999-8888-7777-6666-555555555555',
    },
    consoleSteps: [
        { title: 'Entra admin centre → App registrations → New registration' },
        {
            title: 'Add this redirect URI under Web',
            detail: 'Entra rejects the sign-in if it does not match exactly.',
            copyValue: 'redirectUri',
        },
        {
            title: 'Certificates & secrets → New client secret',
            detail: 'Copy the Value, not the Secret ID. It is shown once.',
        },
        {
            title: 'Token configuration → add the groups claim',
            detail: 'Only needed if you want to map IdP groups to roles here.',
        },
    ],
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
    weight: 10,
}

const OKTA: VendorPreset = {
    id: 'okta',
    name: 'Okta',
    blurb: 'Okta Workforce Identity, OIDC app integration.',
    kind: 'oidc',
    connectLabel: 'Okta domain issuer',
    connectHint: 'https://<your-org>.okta.com/oauth2/default',
    claimMapping: {
        external_id: ['sub'],
        email: ['email'],
        email_verified: ['email_verified'],
        first_name: ['given_name'],
        last_name: ['family_name'],
        groups: ['groups'],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        sub: '00u1a2b3c4D5E6F7G8h9',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        groups: ['Everyone', 'Engineering'],
        auth_time: 1769000000,
    },
    consoleSteps: [
        { title: 'Okta admin → Applications → Create App Integration → OIDC, Web' },
        { title: 'Add this sign-in redirect URI', copyValue: 'redirectUri' },
        {
            title: 'Add a groups claim to the ID token',
            detail: 'Sign On → OpenID Connect ID Token → Groups claim filter.',
        },
    ],
    docsUrl: 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/',
    weight: 20,
}

const AUTH0: VendorPreset = {
    id: 'auth0',
    name: 'Auth0',
    blurb: 'Auth0 by Okta. Regular Web Application.',
    kind: 'oidc',
    connectLabel: 'Auth0 domain issuer',
    connectHint: 'https://<your-tenant>.eu.auth0.com/',
    claimMapping: {
        external_id: ['sub'],
        email: ['email'],
        email_verified: ['email_verified'],
        first_name: ['given_name', 'nickname'],
        last_name: ['family_name'],
        // Auth0 namespaces custom claims; the bare `groups` only exists
        // if a rule/action adds it.
        groups: ['groups', 'https://corp.example/groups'],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        sub: 'auth0|64b7f0c2a1d3e4f5a6b7c8d9',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        nickname: 'ada',
        auth_time: 1769000000,
    },
    consoleSteps: [
        { title: 'Auth0 dashboard → Applications → Create → Regular Web Application' },
        { title: 'Add this Allowed Callback URL', copyValue: 'redirectUri' },
        {
            title: 'Add an Action to emit group claims',
            detail: 'Auth0 does not send groups by default; custom claims must be namespaced.',
        },
    ],
    docsUrl: 'https://auth0.com/docs/get-started/auth0-overview/create-applications/regular-web-apps',
    weight: 30,
}

const KEYCLOAK: VendorPreset = {
    id: 'keycloak',
    name: 'Keycloak',
    blurb: 'Self-hosted Keycloak realm.',
    kind: 'oidc',
    connectLabel: 'Realm issuer URL',
    connectHint: 'https://<host>/realms/<realm>',
    claimMapping: {
        external_id: ['sub'],
        email: ['email'],
        email_verified: ['email_verified'],
        first_name: ['given_name'],
        last_name: ['family_name'],
        groups: ['groups', 'realm_access.roles'],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        sub: 'f:1234abcd:ada',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        groups: ['/engineering'],
        auth_time: 1769000000,
    },
    consoleSteps: [
        { title: 'Keycloak admin → Clients → Create client → OpenID Connect' },
        { title: 'Set Valid redirect URIs to this value', copyValue: 'redirectUri' },
        {
            title: 'Client scopes → add a groups mapper',
            detail: 'Type "Group Membership", token claim name "groups", full path off.',
        },
    ],
    docsUrl: 'https://www.keycloak.org/docs/latest/server_admin/#_oidc_clients',
    weight: 40,
}

const GOOGLE: VendorPreset = {
    id: 'google',
    name: 'Google Workspace',
    blurb: 'Google as an OIDC provider for your domain.',
    kind: 'oidc',
    connectLabel: 'Issuer',
    connectHint: 'https://accounts.google.com',
    claimMapping: {
        external_id: ['sub'],
        email: ['email'],
        email_verified: ['email_verified'],
        first_name: ['given_name'],
        last_name: ['family_name'],
        // Google does not put groups in the ID token at all.
        groups: [],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        sub: '110169484474386276334',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        hd: 'corp.example',
        auth_time: 1769000000,
    },
    consoleSteps: [
        { title: 'Google Cloud console → APIs & Services → Credentials → OAuth client ID' },
        { title: 'Add this Authorised redirect URI', copyValue: 'redirectUri' },
        {
            title: 'Group mapping is not available',
            detail: 'Google omits groups from the ID token. Assign roles here instead, or use Cloud Identity + SAML.',
        },
    ],
    docsUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
    weight: 50,
}

// ── SAML family ──────────────────────────────────────────────────────

const ADFS: VendorPreset = {
    id: 'adfs',
    name: 'AD FS',
    blurb: 'Active Directory Federation Services, SAML 2.0.',
    kind: 'saml2',
    connectLabel: 'Federation metadata URL',
    connectHint: 'https://<host>/FederationMetadata/2007-06/FederationMetadata.xml',
    claimMapping: {
        external_id: [
            'http://schemas.microsoft.com/LiveID/Federation/2008/05/ImmutableID',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
        ],
        email: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
        first_name: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'],
        last_name: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'],
        groups: ['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'],
    },
    sampleClaims: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': 'CORP\\ada',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'ada.lovelace@corp.example',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Ada',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Lovelace',
        'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups': ['Domain Users'],
    },
    consoleSteps: [
        { title: 'AD FS management → Relying Party Trusts → Add' },
        { title: 'Use this SP metadata URL to import our side', copyValue: 'metadataUrl' },
        { title: 'Or set the ACS URL manually', copyValue: 'acsUrl' },
        {
            title: 'Add claim rules for email, given name and surname',
            detail: 'Without an email claim the sign-in resolves no address and is refused.',
        },
    ],
    weight: 60,
}

const GENERIC_OIDC: VendorPreset = {
    id: 'oidc',
    name: 'Other OIDC provider',
    blurb: 'Any provider with a .well-known discovery document.',
    kind: 'oidc',
    connectLabel: 'Issuer URL',
    connectHint: 'https://idp.example.com',
    claimMapping: {
        external_id: ['sub'],
        email: ['email', 'mail'],
        email_verified: ['email_verified'],
        first_name: ['given_name'],
        last_name: ['family_name'],
        groups: ['groups', 'roles'],
        auth_time: ['auth_time'],
    },
    sampleClaims: {
        sub: 'user-1',
        email: 'ada.lovelace@corp.example',
        email_verified: true,
        given_name: 'Ada',
        family_name: 'Lovelace',
        groups: ['engineering'],
    },
    consoleSteps: [
        { title: 'Register a confidential client at your provider' },
        { title: 'Add this redirect URI', copyValue: 'redirectUri' },
    ],
    weight: 70,
}

const GENERIC_SAML: VendorPreset = {
    id: 'saml2',
    name: 'Other SAML 2.0 provider',
    blurb: 'PingFederate, OneLogin, Shibboleth, and the rest.',
    kind: 'saml2',
    connectLabel: 'IdP metadata URL or XML',
    connectHint: 'https://idp.example.com/metadata',
    claimMapping: {
        external_id: ['NameID', 'nameId'],
        email: ['email', 'mail', 'emailAddress'],
        first_name: ['givenName', 'firstName'],
        last_name: ['surname', 'sn', 'lastName'],
        groups: ['groups', 'memberOf'],
    },
    sampleClaims: {
        NameID: 'ada@corp.example',
        email: 'ada.lovelace@corp.example',
        givenName: 'Ada',
        surname: 'Lovelace',
        memberOf: ['engineering'],
    },
    consoleSteps: [
        { title: 'Create a SAML application at your IdP' },
        { title: 'Import our SP metadata', copyValue: 'metadataUrl' },
        { title: 'Or set the ACS (Assertion Consumer Service) URL', copyValue: 'acsUrl' },
        { title: 'Set the SP entity ID', copyValue: 'entityId' },
    ],
    weight: 80,
}

// ── The internal case ────────────────────────────────────────────────

const CORPORATE_PORTAL: VendorPreset = {
    id: 'custom_profile',
    name: 'Corporate portal',
    blurb: 'A portal or proxy that already signed the user in and hands us their profile.',
    kind: 'custom_profile',
    connectLabel: 'Where the profile arrives',
    claimMapping: {
        external_id: ['sub', 'employeeId', 'userId', 'id'],
        email: ['emailAddress', 'email', 'mail', 'upn'],
        first_name: ['firstName', 'givenName', 'given_name'],
        last_name: ['lastName', 'surname', 'family_name'],
        groups: ['groups', 'roles', 'memberOf'],
    },
    sampleClaims: {
        sub: 'S-1-5-21-1004',
        employeeId: '100482',
        emailAddress: 'ada.lovelace@corp.example',
        firstName: 'Ada',
        lastName: 'Lovelace',
        department: 'Engineering',
        groups: ['engineering', 'staff'],
    },
    consoleSteps: [
        {
            title: 'Decide where the profile comes from',
            detail: 'A cookie or a proxy header is read server-side. Browser storage is read by JavaScript and posted back.',
        },
        {
            title: 'Sign the payload',
            detail: 'A signed JWT is what earns this connection a "verified" rating. An unsigned payload means anyone who can write the cookie can be anyone.',
        },
        {
            title: 'If you use a proxy header, strip inbound copies at the edge',
            detail: 'Otherwise a caller can set the header themselves and impersonate any user.',
        },
    ],
    weight: 90,
}

const ENTERPRISE_GATEWAY: VendorPreset = {
    id: 'backchannel',
    name: 'Enterprise gateway',
    blurb: 'An internal service we ask for the user, using the session they already have.',
    kind: 'backchannel',
    connectLabel: 'The two calls we make',
    claimMapping: {
        external_id: ['sub', 'userId', 'employeeId', 'uid'],
        email: ['email', 'emailAddress', 'mail', 'upn'],
        first_name: ['firstName', 'givenName', 'given_name'],
        last_name: ['lastName', 'surname', 'family_name'],
        groups: ['groups', 'roles', 'memberOf'],
        // Deliberately no ``iat``: there is no token being read here, so
        // an ``iat`` in the response would be the response's own age
        // rather than when the person signed in — and satisfying the
        // daily re-authentication ceiling with it would defeat it.
        auth_time: ['auth_time', 'authTime', 'authenticationTime'],
    },
    sampleClaims: {
        sub: 'emp-100482',
        email: 'ada.lovelace@corp.example',
        firstName: 'Ada',
        lastName: 'Lovelace',
        department: 'Engineering',
        groups: ['engineering', 'staff'],
        auth_time: 1700000000,
    },
    consoleSteps: [
        {
            title: 'Name the session cookie their portal already sets',
            detail: 'It has to reach us, which means a cookie on a domain we share with the portal. We never read what is inside it.',
        },
        {
            title: 'Point us at the endpoint that redeems it',
            detail: 'We send the session, they send back a token. Tell us where the token sits in their response.',
        },
        {
            title: 'Point us at the endpoint that returns the user',
            detail: 'Optional — if the first call already returns the user, leave it blank and we will skip a round trip.',
        },
        {
            title: 'Say who redeems the session, and how the answer arrives',
            detail: 'If the cookie is scoped to the SSO host alone, switch the exchange to the browser and give us their JWKS URL — a browser-delivered token is verified against it. If their reply is a signed token (JWT) rather than a plain user object, say so and the claims are read from its payload.',
        },
        {
            title: 'Allow the gateway host',
            detail: 'These endpoints are internal, so they are unreachable until someone with the SSO hosts permission adds the host to the allowlist. The JWKS URL needs an entry too when it is internal.',
        },
    ],
    weight: 95,
}

export const VENDOR_PRESETS: VendorPreset[] = [
    ENTRA, OKTA, AUTH0, KEYCLOAK, GOOGLE,
    ADFS, GENERIC_SAML, GENERIC_OIDC, CORPORATE_PORTAL,
    ENTERPRISE_GATEWAY,
].sort((a, b) => a.weight - b.weight)

export function presetById(id: string): VendorPreset | undefined {
    return VENDOR_PRESETS.find(p => p.id === id)
}

/** Substitute this deployment's real values into a console step.
 *
 *  The placeholder is deliberately NOT encoded: these are shown while the
 *  operator is still naming the connection, and `%3Cslug%3E` reads as a
 *  broken URL rather than as "your name goes here". A real slug is
 *  encoded, since it reaches the address bar. */
export function consoleValues(slug: string, origin: string) {
    const segment = slug ? encodeURIComponent(slug) : '<slug>'
    const base = `${origin}/api/v1/auth/${segment}`
    return {
        redirectUri: `${base}/callback`,
        acsUrl: `${base}/acs`,
        metadataUrl: `${base}/metadata`,
        entityId: origin,
    }
}
