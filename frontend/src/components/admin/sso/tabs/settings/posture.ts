/**
 * What the four switches add up to.
 *
 * They are independent booleans, and the page showed them as four
 * independent rows — so the one question an operator actually has ("what
 * happens when somebody opens the sign-in page right now?") had to be
 * assembled in their head from four descriptions written in terms of HTTP
 * status codes.
 *
 * This derives that sentence, and the risks that only exist in
 * *combination*. Pure, so the interesting cases are unit-testable without
 * rendering anything.
 */
import type { AuthConfig, IdpProvider } from '@/services/ssoAdminService'
import { toUtcDate } from '@/lib/timeAgo'

export type PostureTone = 'ok' | 'warn' | 'danger'

export interface Posture {
    tone: PostureTone
    /** One line: what a person arriving at /login gets. */
    headline: string
    /** Consequences worth stating before someone changes anything. */
    notes: string[]
}

export interface RiskCheck {
    /** The switch this is about, so the row can carry it. */
    field: keyof AuthConfig
    tone: PostureTone
    message: string
}

/** Live connections — the only ones a person at the sign-in page sees. */
function publicProviders(providers: IdpProvider[]): IdpProvider[] {
    return providers.filter(p => p.enabled && p.lifecycle !== 'draft')
}

/**
 * The connection the sign-in page leads with, and where a typed address
 * that matches no email domain goes: the first live one an address can be
 * routed to. That skips the development ``custom`` kind and a portal whose
 * payload sits in browser storage. The list arrives in login-page order
 * (priority, then slug) — the server's own, so the two cannot disagree.
 */
export function primaryConnection(providers: IdpProvider[]): IdpProvider | null {
    return publicProviders(providers).find(p =>
        p.kind !== 'custom'
        && !(p.kind === 'custom_profile'
            && ['local_storage', 'session_storage'].includes(String(p.settings?.source))),
    ) ?? null
}

/** Whether the emergency window lets everyone use a password right now. */
export function fallbackOpen(cfg: AuthConfig, now: number): boolean {
    const until = toUtcDate(cfg.passwordFallbackUntil)
    return until !== null && until.getTime() > now
}

export function describePosture(
    cfg: AuthConfig | null, providers: IdpProvider[], now = Date.now(),
): Posture {
    if (!cfg) return { tone: 'ok', headline: '', notes: [] }

    const live = publicProviders(providers)
    const drafts = providers.filter(p => p.lifecycle === 'draft').length
    const notes: string[] = []

    if (drafts) {
        notes.push(
            `${drafts} connection${drafts === 1 ? ' is' : 's are'} still a draft ` +
            'and invisible here — publish from the Providers tab.',
        )
    }

    // The genuinely dangerous corner, and it is invisible on any single
    // row: both doors shut. The server refuses this combination outright —
    // one PATCH or two, the stored row is merged in first, so turning SSO
    // off after local login is already off hits the same 409. Still
    // described here, because the state can exist anyway (a seed, a direct
    // DB edit) and "nobody can sign in" matters more than how it happened.
    if (!cfg.ssoEnabled && !cfg.allowLocalLogin) {
        return {
            tone: 'danger',
            headline: 'Nobody can sign in. Single sign-on is off and so are passwords.',
            notes: [
                'Turn one of them back on. Existing sessions keep working until ' +
                'they expire, so there is a window to fix this.',
                ...notes,
            ],
        }
    }

    if (!cfg.ssoEnabled) {
        return {
            tone: 'warn',
            headline: 'Passwords only. Every SSO connection is switched off at the master switch.',
            notes: [
                'Connections keep their configuration — turning single sign-on ' +
                'back on restores them exactly as they were.',
                'People who signed in through a connection stay signed in ' +
                'until their sessions expire, unless you end those sessions ' +
                'from this page.',
                ...notes,
            ],
        }
    }

    if (!live.length) {
        return {
            tone: 'warn',
            headline: cfg.allowLocalLogin || fallbackOpen(cfg, now)
                ? 'Passwords only — single sign-on is on, but no connection is live yet.'
                : 'Nobody can sign in: passwords are off and no connection is live yet.',
            notes: [
                drafts
                    ? 'Publishing a draft is what makes it appear.'
                    : 'Connect a provider from the Providers tab.',
            ],
        }
    }

    const names = live.map(p => p.displayName || p.slug)
    const listed = names.length <= 2
        ? names.join(' and ')
        : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`

    // Single sign-on leads; a password is a step behind it — for anyone,
    // or with the switch off, for break-glass accounts only.
    const how = cfg.emailFirstLogin
        ? `People are asked for their email address and routed to the right one — ${listed}.`
        : `People continue with ${listed}, or type their email.`
    const passwords = cfg.allowLocalLogin
        ? 'Anyone can fall back to a password.'
        : fallbackOpen(cfg, now)
            ? 'Anyone can use a password while emergency access is open.'
            : 'Passwords are off — break-glass accounts only.'
    const primary = primaryConnection(live)
    // Off, the break-glass accounts are the way back in when the IdP is
    // not. Shown here because no single row can say it once it is off.
    const exposed = !cfg.allowLocalLogin && cfg.breakGlass?.ready === false

    return {
        tone: exposed ? 'danger' : 'ok',
        headline: `${how} ${passwords}`,
        notes: [
            ...(exposed ? [
                'No break-glass account is ready — an IdP outage could lock ' +
                'everyone out. Make one under Admin → Users.',
            ] : []),
            ...(primary && live.length > 1 ? [
                'An address that matches no email domain goes to ' +
                `${primary.displayName || primary.slug}, the primary connection.`,
            ] : []),
            cfg.allowJitProvisioning
                ? 'Someone signing in for the first time gets an account automatically.'
                : 'Accounts must exist before someone can sign in — no account is created automatically.',
            ...notes,
        ],
    }
}

/**
 * Per-switch risks that depend on the rest of the world.
 *
 * These are the checks the server also makes, surfaced *before* the click
 * rather than as a 409 afterwards — except the email-domain one, which the
 * server cannot make at all because a lopsided routing is a valid
 * configuration, just an unhelpful one.
 */
export function riskChecks(
    cfg: AuthConfig | null, providers: IdpProvider[],
): RiskCheck[] {
    if (!cfg) return []
    const out: RiskCheck[] = []
    const live = publicProviders(providers)

    // Email-first folds the buttons away, and an address matching no
    // domain goes to the primary — so a connection that is neither, nobody
    // reaches by typing.
    if (cfg.emailFirstLogin) {
        const primary = primaryConnection(live)
        const stranded = live
            .filter(p => p !== primary && !(p.emailDomains ?? []).length)
            .map(p => p.displayName || p.slug)
        if (stranded.length) {
            out.push({
                field: 'emailFirstLogin',
                tone: 'warn',
                message:
                    `${stranded.join(', ')} ${stranded.length === 1 ? 'has' : 'have'} ` +
                    'no email domains, so typing an address never reaches ' +
                    `${stranded.length === 1 ? 'it' : 'them'} — only the ` +
                    '"Other ways to sign in" buttons do.',
            })
        }
    }

    if (cfg.allowLocalLogin) {
        // Turning this off is refused server-side without a ready
        // break-glass account, and lists Super Admins who have no SSO
        // identity. Saying so up front turns a 409 into an expectation.
        out.push(cfg.breakGlass?.ready === false ? {
            field: 'allowLocalLogin',
            tone: 'danger',
            message:
                'No break-glass account is ready, so turning this off is ' +
                'refused — first mark an active Super Admin who has a ' +
                'password as a system account, under Admin → Users.',
        } : {
            field: 'allowLocalLogin',
            tone: 'warn',
            message:
                'Turning this off first lists any Super Admin with no SSO ' +
                'identity who is not a system account — they could not sign ' +
                'in. System accounts keep password sign-in as the break-glass.',
        })
    }

    if (cfg.ssoEnabled && !cfg.allowLocalLogin) {
        out.push({
            field: 'ssoEnabled',
            tone: 'danger',
            message:
                'Passwords are off, so this is the only way in. Turning it off ' +
                'locks everyone out.',
        })
    }

    return out
}
