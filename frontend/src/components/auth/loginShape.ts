/**
 * The login page's decisions, kept apart from its rendering.
 *
 * Which connection Enter goes to, who may use a password, and what the
 * page opens on are all functions of the login context alone. Here they
 * are plain functions with a matrix test (``loginShape.test.ts``) rather
 * than conditions spread across a thousand-line component.
 */
import {
    needsBrowserPayload,
    type LoginContext,
    type PasswordAccess,
    type SsoProviderSummary,
} from '@/services/authService'

/** ``local`` is the single-step password form: no connections, or a
 *  context that never arrived (fail open). ``sso`` leads with single
 *  sign-on and keeps the password behind a step of its own. */
export type LoginShape = 'loading' | 'local' | 'sso'

export type LoginStep = 'identify' | 'password'

export type LoginNotice =
    | { kind: 'outage'; providers: string[] }
    | { kind: 'window'; until: string }

export function loginShape(
    ctx: LoginContext | null, failed: boolean, devLogin: boolean,
): LoginShape {
    if (failed) return 'local'
    if (!ctx) return 'loading'
    return (ctx.providers?.length ?? 0) > 0 || devLogin ? 'sso' : 'local'
}

/** The connection Enter goes to when the address names none: the first
 *  one this page can route to, in login-page order (the catalog arrives
 *  sorted by priority, then slug). Not the dev mock, and not a portal
 *  whose credential lives in this browser's storage — pressing its button
 *  reads that storage, but an address that matched nothing says nothing
 *  about whether the payload is there. A gateway connection qualifies:
 *  the page runs its browser half itself. */
export function primaryConnection(
    providers: SsoProviderSummary[],
): SsoProviderSummary | null {
    return providers.find((p) => p.kind !== 'custom' && !needsBrowserPayload(p))
        ?? null
}

/** A domain match wins; otherwise the primary; otherwise nowhere. */
export function routeTarget(
    resolved: SsoProviderSummary | null,
    providers: SsoProviderSummary[],
): SsoProviderSummary | null {
    return resolved ?? primaryConnection(providers)
}

/** Who may use a password. A context that never arrived is everyone —
 *  the server still decides — and so is a server that predates the
 *  field, unless its ``allowLocalLogin`` already said passwords are off. */
export function passwordAudience(ctx: LoginContext | null): PasswordAccess {
    if (!ctx) return 'everyone'
    const access = ctx.passwordAccess
    if (access === 'everyone' || access === 'administrators' || access === 'break_glass') {
        return access
    }
    return ctx.allowLocalLogin === false ? 'break_glass' : 'everyone'
}

/** The step an SSO-first page opens on. ``?password=1`` is the break-glass
 *  door; an outage that opened passwords to everyone leads with them. */
export function openingStep(
    ctx: LoginContext | null, breakGlass: boolean,
): LoginStep {
    if (breakGlass) return 'password'
    return ctx?.ssoOutage && passwordAudience(ctx) === 'everyone'
        ? 'password'
        : 'identify'
}

/** The banner above the steps. An outage outranks the window: it says
 *  why the window exists, and the window is already in its advice. */
export function loginNotice(ctx: LoginContext | null): LoginNotice | null {
    if (ctx?.ssoOutage) {
        return { kind: 'outage', providers: ctx.ssoOutage.providers ?? [] }
    }
    if (ctx?.passwordFallbackUntil) {
        return { kind: 'window', until: ctx.passwordFallbackUntil }
    }
    return null
}
