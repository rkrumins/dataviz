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

export function describePosture(
    cfg: AuthConfig | null, providers: IdpProvider[],
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
    // row: both doors shut. The server refuses the combination that would
    // strand an admin, but it cannot refuse this one — it is reachable by
    // turning SSO off *after* local login is already off.
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
                ...notes,
            ],
        }
    }

    if (!live.length) {
        return {
            tone: 'warn',
            headline: cfg.allowLocalLogin
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

    const how = cfg.emailFirstLogin
        ? 'People are asked for their email address and routed to the right one'
        : `People choose from ${names.length === 1 ? 'a button' : `${names.length} buttons`}`

    return {
        tone: 'ok',
        headline: cfg.allowLocalLogin
            ? `${how} — ${listed} — or sign in with a password.`
            : `${how} — ${listed}. Passwords are off.`,
        notes: [
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
 * server cannot make at all because an unroutable address is a valid
 * configuration, just a useless one.
 */
export function riskChecks(
    cfg: AuthConfig | null, providers: IdpProvider[],
): RiskCheck[] {
    if (!cfg) return []
    const out: RiskCheck[] = []
    const live = publicProviders(providers)

    if (cfg.emailFirstLogin || live.length) {
        const routable = live.filter(p => (p.emailDomains ?? []).length)
        if (cfg.emailFirstLogin && !routable.length) {
            out.push({
                field: 'emailFirstLogin',
                tone: 'danger',
                message:
                    'No live connection has email domains set, so no address can ' +
                    'route anywhere — everyone falls through to the password form. ' +
                    'Set domains on each connection first.',
            })
        } else if (cfg.emailFirstLogin && routable.length < live.length) {
            const stranded = live.filter(p => !(p.emailDomains ?? []).length)
                .map(p => p.displayName || p.slug)
            out.push({
                field: 'emailFirstLogin',
                tone: 'warn',
                message:
                    `${stranded.join(', ')} ${stranded.length === 1 ? 'has' : 'have'} ` +
                    'no email domains, so nobody can reach ' +
                    `${stranded.length === 1 ? 'it' : 'them'} this way.`,
            })
        }
    }

    if (cfg.allowLocalLogin) {
        // Turning this off is refused server-side when an admin has no SSO
        // identity. Saying so up front turns a 409 into an expectation.
        out.push({
            field: 'allowLocalLogin',
            tone: 'warn',
            message:
                'Turning this off is refused if any active admin has no linked ' +
                'SSO identity — nobody gets locked out by this switch.',
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
