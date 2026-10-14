/**
 * The SSO-first page's decisions, as a matrix.
 *
 * Enter must always lead somewhere useful: a domain match, else the
 * primary connection, else (and only then) the password step or the
 * buttons. And who may use a password has to survive a server that does
 * not send the field yet — without offering a password to everyone on a
 * deployment that already said passwords are off.
 */
import { describe, expect, it } from 'vitest'
import type { LoginContext, SsoProviderSummary } from '@/services/authService'
import {
    loginNotice,
    loginShape,
    openingStep,
    passwordAudience,
    primaryConnection,
    routeTarget,
} from './loginShape'

const p = (slug: string, kind: string, config?: SsoProviderSummary['config']) => ({
    id: `idp_${slug}`, slug, displayName: slug, kind, priority: 100, config,
}) as SsoProviderSummary

const OIDC = p('entra', 'oidc')
const SAML = p('okta', 'saml2')
const DEV = p('mock', 'custom')
const STORAGE_PORTAL = p('portal', 'custom_profile', {
    source: 'local_storage', sourceKey: 'corp.user',
})
const COOKIE_PORTAL = p('cookie-portal', 'custom_profile', { source: 'cookie' })
const GATEWAY = p('gateway', 'backchannel', {
    authenticateUrl: 'https://sso.corp.example/authenticate',
})
const AMBIENT = p('ambient', 'backchannel', {})

function ctx(over: Partial<LoginContext> = {}): LoginContext {
    return { allowLocalLogin: true, emailFirstLogin: false, providers: [], ...over }
}

describe('primaryConnection', () => {
    it.each([
        ['nothing configured', [], null],
        ['the first connection, in catalog order', [OIDC, SAML], OIDC],
        ['past the dev mock', [DEV, SAML], SAML],
        ['past a browser-storage portal', [STORAGE_PORTAL, OIDC], OIDC],
        ['a cookie-sourced portal (read server-side)', [COOKIE_PORTAL, OIDC], COOKIE_PORTAL],
        ['a gateway connection (the page runs its browser half)', [GATEWAY, OIDC], GATEWAY],
        ['an ambient back-channel row', [AMBIENT], AMBIENT],
        ['none when only the dev mock exists', [DEV], null],
        ['none when only a browser-storage portal exists', [STORAGE_PORTAL, DEV], null],
    ] as const)('%s', (_, providers, expected) => {
        expect(primaryConnection([...providers])).toBe(expected)
    })
})

describe('routeTarget', () => {
    it('a domain match wins over the primary', () => {
        expect(routeTarget(SAML, [OIDC, SAML])).toBe(SAML)
    })

    it('falls back to the primary on a miss', () => {
        expect(routeTarget(null, [OIDC, SAML])).toBe(OIDC)
    })

    it('is nowhere when nothing is routable', () => {
        expect(routeTarget(null, [STORAGE_PORTAL, DEV])).toBeNull()
    })
})

describe('passwordAudience', () => {
    it.each([
        ['a context that never arrived', null, 'everyone'],
        ['everyone', ctx({ passwordAccess: 'everyone' }), 'everyone'],
        ['administrators', ctx({ allowLocalLogin: false, passwordAccess: 'administrators' }), 'administrators'],
        ['break-glass', ctx({ allowLocalLogin: false, passwordAccess: 'break_glass' }), 'break_glass'],
        ['an older server with passwords on', ctx(), 'everyone'],
        ['an older server with passwords off', ctx({ allowLocalLogin: false }), 'break_glass'],
        ['a value this page does not know', ctx({ passwordAccess: 'nobody' as never }), 'everyone'],
    ] as const)('%s', (_, context, expected) => {
        expect(passwordAudience(context)).toBe(expected)
    })
})

describe('loginShape', () => {
    it.each([
        ['loading', null, false, false, 'loading'],
        ['a failed context fails open to the password form', null, true, false, 'local'],
        ['no connections keeps the single-step form', ctx(), false, false, 'local'],
        ['any connection leads with single sign-on', ctx({ providers: [OIDC] }), false, false, 'sso'],
        ['the dev login button counts as a connection', ctx(), false, true, 'sso'],
    ] as const)('%s', (_, context, failed, devLogin, expected) => {
        expect(loginShape(context, failed, devLogin)).toBe(expected)
    })
})

describe('openingStep', () => {
    const outage = { since: '2026-10-13T09:00:00Z', providers: ['entra'] }

    it.each([
        ['an ordinary visit', ctx({ providers: [OIDC] }), false, 'identify'],
        ['?password=1', ctx({ allowLocalLogin: false, passwordAccess: 'break_glass' }), true, 'password'],
        ['an outage with passwords open to everyone',
            ctx({ passwordAccess: 'everyone', ssoOutage: outage }), false, 'password'],
        ['an outage open to administrators only',
            ctx({ allowLocalLogin: false, passwordAccess: 'administrators', ssoOutage: outage }), false, 'identify'],
        ['the window alone', ctx({ passwordFallbackUntil: '2026-10-13T12:00:00Z' }), false, 'identify'],
    ] as const)('%s', (_, context, breakGlass, expected) => {
        expect(openingStep(context, breakGlass)).toBe(expected)
    })
})

describe('loginNotice', () => {
    it('is nothing on an ordinary day', () => {
        expect(loginNotice(ctx())).toBeNull()
        expect(loginNotice(null)).toBeNull()
    })

    it('names the connections that are down', () => {
        expect(loginNotice(ctx({
            ssoOutage: { since: '2026-10-13T09:00:00Z', providers: ['entra', 'okta'] },
        }))).toEqual({ kind: 'outage', providers: ['entra', 'okta'] })
    })

    it('says when the window closes', () => {
        expect(loginNotice(ctx({ passwordFallbackUntil: '2026-10-13T12:00:00Z' })))
            .toEqual({ kind: 'window', until: '2026-10-13T12:00:00Z' })
    })

    it('lets an outage outrank the window', () => {
        expect(loginNotice(ctx({
            ssoOutage: { since: '2026-10-13T09:00:00Z', providers: ['entra'] },
            passwordFallbackUntil: '2026-10-13T12:00:00Z',
        }))?.kind).toBe('outage')
    })
})
