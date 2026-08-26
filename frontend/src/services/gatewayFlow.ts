/**
 * The browser's half of a back-channel sign-in, composed once.
 *
 * Three surfaces need exactly this sequence — the sign-in page's
 * buttons and email-first CTA, the silent session recovery, and
 * self-service identity linking — and before this module the second
 * and third either duplicated it or fell back to a plain navigation
 * that cannot run it.
 *
 * A separate module rather than more of ``authService`` on purpose:
 * these functions compose ``runAuthenticateTrigger`` and
 * ``runBrowserExchange`` *through the module boundary*, so a test that
 * stubs those two on ``authService`` stubs them here as well. Folded
 * into ``authService`` the calls would be intra-module and
 * unstubbable.
 */
import {
    needsAuthenticateFirst,
    needsBrowserExchange,
    runAuthenticateTrigger,
    runBrowserExchange,
    type SsoProviderSummary,
} from './authService'

/** True for a provider the browser has to drive: a sign-in trigger to
 *  run, a browser-side exchange to make, or both. Everything else
 *  starts with a plain navigation. */
export function isGatewayProvider(p: SsoProviderSummary): boolean {
    return needsAuthenticateFirst(p) || needsBrowserExchange(p)
}

/** Run the browser's half of a back-channel sign-in and return the body
 *  to post to `/auth/{slug}/backchannel`.
 *
 *  The browser's half cannot move to our server, and that is not a
 *  preference. Where the enterprise uses Kerberos the provider answers
 *  `401 WWW-Authenticate: Negotiate`, and answering it needs a Service
 *  Ticket from the workstation's OS credential store — reachable through
 *  SSPI or GSS-API, by this browser, on this machine. And where the
 *  corporate cookie is scoped to the SSO host alone, only this browser's
 *  cookie jar can present it to the translate endpoint.
 *
 *  Three bodies come back, matching the three configurations: an
 *  `assertion` from the browser exchange, a `handle` the trigger
 *  answered with, or `{}` — the trigger set a cookie on a shared domain
 *  and the server reads it off the POST itself. Throws when a call
 *  failed, so the caller can say which step.
 */
export async function gatewaySignInBody(
    p: SsoProviderSummary,
): Promise<{ handle?: string; assertion?: string }> {
    if (needsBrowserExchange(p)) {
        // The trigger (when present) establishes the corporate session.
        // When the row names a body field, the token the trigger
        // answered with is also forwarded into the translate POST —
        // some gateways require it in the body; otherwise the cookie
        // alone carries the session and the answer goes unused.
        const token = needsAuthenticateFirst(p)
            ? await runAuthenticateTrigger(p)
            : null
        return { assertion: await runBrowserExchange(p, token) }
    }
    const handle = await runAuthenticateTrigger(p)
    return handle ? { handle } : {}
}
