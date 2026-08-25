/**
 * The failure code, in words, where it is read.
 *
 * `audit.py` renders these into the summary the activity table prints —
 * `Sign-in via {slug} failed: {reason}` and `Refused {who} from {slug}:
 * {deny_reasons}`. The codes are precise and completely opaque unless you
 * know the schema, and the person reading them is mid-incident with a
 * colleague waiting.
 *
 * The same table exists in the operations guide, which is the right place
 * to read it once. This is the other half: at 2am, leaving the tab to find
 * an article is exactly the wrong ask.
 *
 * Unknown codes fall through rather than being swallowed — a reason we have
 * not catalogued is still the most useful thing on the row, and hiding it
 * to keep the component tidy would be a bad trade.
 */
import { HelpCircle } from 'lucide-react'

interface Reason {
    what: string
    next: string
}

/**
 * Keyed on the exact strings the backend emits: `SsoDecision.error` values
 * and `_link_deny_reasons` entries. Prefixed reasons (`policy:*`,
 * `existing_status:*`) are matched by prefix below.
 */
const REASONS: Record<string, Reason> = {
    // ── back-channel connections ─────────────────────────────────────
    // These call out to a service on your own network, so they fail in
    // ways the other kinds cannot. The allowlist one is first because it
    // is both the likeliest and the least guessable.
    backchannel_unavailable: {
        what: 'We could not reach the sign-in gateway, or it did not '
            + 'answer properly.',
        next: 'Check the host allowlist first — Settings → Internal '
            + 'gateways SSO may call — including the port, which is part '
            + 'of the entry. Otherwise it is an outage on their side.',
    },
    backchannel_no_session: {
        what: 'The request arrived without the corporate session the '
            + 'connection expects.',
        next: 'Usually correct — they are not signed in to the portal. If '
            + 'they say they are, the cookie is not reaching us: check its '
            + 'Domain attribute covers this app\u2019s hostname.',
    },
    backchannel_token_absent: {
        what: 'The gateway answered, but with nothing where we were told '
            + 'the token would be.',
        next: 'The path in the connection\u2019s settings does not match '
            + 'what they actually send. Rehearse a sign-in and read the '
            + 'reply.',
    },
    backchannel_claims_absent: {
        what: 'The exchange answered, but with nothing where we were told '
            + 'the user\u2019s details would be.',
        next: 'Same as above, for the second call\u2019s path.',
    },
    backchannel_claims_unmappable: {
        what: 'Their details came back, but a field the claim mapping '
            + 'needs was missing.',
        next: 'Open the connection\u2019s Claim mapping and check it '
            + 'against what actually arrived.',
    },
    backchannel_auth_time_absent: {
        what: 'Their reply carried no authentication time, and this '
            + 'connection requires one.',
        next: 'Ask their team to include it. Turning the requirement off '
            + 'is possible and quietly disables the daily '
            + 're-authentication ceiling for everyone on this connection.',
    },
    backchannel_jwt_invalid: {
        what: 'The reply carried a signed token we could not accept — '
            + 'undecodable, wrong signature, unknown key, or an issuer '
            + 'or audience that does not match the pins.',
        next: 'Compare the connection’s JWKS URL and issuer/audience '
            + 'pins against what their team publishes. The server log '
            + 'names the exact refusal under this reference.',
    },
    backchannel_jwt_expired: {
        what: 'The signed token in their reply had already expired.',
        next: 'Usually clock skew or a gateway answering from a cache — '
            + 'theirs to investigate. Repeat occurrences mean their '
            + 'token lifetime is shorter than the call is slow.',
    },
    backchannel_replayed: {
        what: 'A browser-delivered sign-in token was presented a second '
            + 'time. Each one signs in at most once.',
        next: 'Once is usually a double-submitted sign-in and harmless. '
            + 'A pattern of these is someone replaying captured tokens — '
            + 'treat it as an incident and involve the gateway team.',
    },
    backchannel_failed: {
        what: 'The back-channel sign-in failed for a reason we have not '
            + 'catalogued.',
        next: 'The server log carries the detail, under the same '
            + 'reference as this row.',
    },
    jit_disabled: {
        what: 'They have no account here, and automatic account creation is off.',
        next: 'Create the account or send an invite — or turn the switch on in Settings.',
    },
    sso_disabled: {
        what: 'Single sign-on is switched off at the master switch.',
        next: 'Settings → Single sign-on.',
    },
    unsafe_auto_link: {
        what: 'An account with that email exists, but the linking policy refused to link it.',
        next: 'The specific reasons are listed alongside this one.',
    },
    strict_existing_sso: {
        what: 'That account already has an SSO identity, and this connection is set to Strict.',
        next: 'Move this connection to “Allow verified”, or have them link it from their own account page.',
    },
    email_unverified: {
        what: 'Their identity provider did not say the address is verified.',
        next: 'Verify it in the IdP, or map a claim that carries verification.',
    },
    existing_deleted: {
        what: 'The account that email belongs to was deleted.',
        next: 'Restore it, or let a new one be created.',
    },
    sso_account_inactive: {
        what: 'Their linked account is no longer active.',
        next: 'Check the account under Admin → Users.',
    },
    link_target_inactive: {
        what: 'The account they would link to is not active.',
        next: 'Reactivate it first.',
    },
    invalid_credentials: {
        what: 'A password sign-in with the wrong password.',
        next: 'Nothing to fix here unless it repeats — this is not an SSO failure.',
    },
    user_not_found: {
        what: 'A password sign-in for an address with no account.',
        next: 'Nothing to fix here unless it repeats — this is not an SSO failure.',
    },
}

const PREFIXED: { prefix: string; build: (rest: string) => Reason }[] = [
    {
        prefix: 'policy:',
        build: rest => ({
            what: rest === 'manual_only'
                ? 'This connection never links to an existing account automatically, by design.'
                : 'Linking is switched off for this connection.',
            next: rest === 'manual_only'
                ? 'They link it themselves from their own account page.'
                : 'Change the linking policy, or expect them to get a separate account.',
        }),
    },
    {
        // The status is the useful half: 401 and 403 are both "the
        // provider said no", but a sudden run of them means different
        // things to the team who owns it.
        prefix: 'backchannel_idp_rejected:',
        build: rest => ({
            what: `Their sign-in provider answered ${rest} — it does not `
                + 'consider this person signed in.',
            next: 'Usually correct: they signed out of the corporate '
                + 'portal, or their workstation session ended. Worth '
                + 'investigating only if they say they are still signed in '
                + 'there.',
        }),
    },
    {
        prefix: 'existing_status:',
        build: rest => ({
            what: `The account with that email is ${rest}, so it cannot be linked.`,
            next: rest === 'pending'
                ? 'Approve it under Admin → Users.'
                : 'Reinstate it under Admin → Users, if that is what you want.',
        }),
    },
]

/** Every code we can explain, exposed so the guide's table and this
 *  component cannot drift apart unnoticed. */
export function explainReason(code: string): Reason | null {
    const key = code.trim()
    if (REASONS[key]) return REASONS[key]
    for (const { prefix, build } of PREFIXED) {
        if (key.startsWith(prefix)) return build(key.slice(prefix.length))
    }
    return null
}

/**
 * Pull the codes out of a rendered audit summary.
 *
 * The summaries put reasons after a colon — `…failed: jit_disabled`,
 * `Refused a@b from entra: email_unverified, strict_existing_sso`. Parsing
 * the rendered string rather than the payload keeps this to a display
 * concern; the alternative is widening the audit DTO for a tooltip.
 */
export function codesIn(summary: string): string[] {
    const tail = summary.split(': ').slice(1).join(': ')
    if (!tail) return []
    return tail.split(',')
        .map(s => s.trim())
        // Several colon-separated segments, and digits, because a status
        // code is worth carrying: `backchannel_idp_rejected:401` says
        // something `backchannel_idp_rejected` does not. Still a closed
        // shape — anything with a space, a quote or a slash in it is not
        // a code, and the backend is written so none reach here.
        .filter(s => /^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$/.test(s))
}

export function ReasonHint({ summary }: { summary: string }) {
    const explained = codesIn(summary)
        .map(c => [c, explainReason(c)] as const)
        .filter((pair): pair is readonly [string, Reason] => pair[1] !== null)

    if (!explained.length) return null

    return (
        <div className="mt-1 space-y-1">
            {explained.map(([code, r]) => (
                <p
                    key={code}
                    className="flex items-start gap-1.5 text-[11px] text-ink-muted leading-relaxed"
                >
                    <HelpCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>
                        {r.what}{' '}
                        <span className="text-ink-secondary">{r.next}</span>
                    </span>
                </p>
            ))}
        </div>
    )
}
