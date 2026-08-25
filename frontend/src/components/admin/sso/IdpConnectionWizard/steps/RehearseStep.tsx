/**
 * Rehearse — the step that makes publishing safe.
 *
 * `/test` checks the claim mapping against a pasted blob. This checks the
 * half that actually breaks in production: is the redirect URI registered,
 * does the signature verify, is the clock skewed, is the certificate still
 * valid. Until this branch existed, the first real test of an SSO
 * connection was a user failing to sign in.
 *
 * The operator signs in with their own account against the draft. Nothing
 * is written and no session is minted — they come back here and press
 * Publish, or go back and fix the mapping.
 *
 * The wizard will not advance until this has actually returned. That is
 * the one hard gate in the flow, and it is what turns "nothing is live
 * until you publish" from a slogan into a guarantee.
 */
import { useState } from 'react'
import { FlaskConical, Loader2, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { StepColumn, StepHero, StepBlock, Hint } from '@/components/admin/InviteWizard/ui'
import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import {
    runAuthenticateCall,
    runBrowserExchangeCall,
} from '@/services/authService'

export function RehearseStep({
    provider, kind, rehearsed, onRehearsed, onCreateDraft, saving,
}: {
    provider: IdpProvider | null
    /** The preset's kind, known before the draft exists — the checklist
     *  copy follows it, because promising "the redirect URI is
     *  registered" about a connection with no redirect URI teaches the
     *  operator the checklist is decoration. */
    kind?: string
    rehearsed: boolean
    onRehearsed: () => void
    onCreateDraft: () => Promise<IdpProvider | null>
    saving: boolean
}) {
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Inline rehearsals (handle and browser shapes) report here rather
    // than in a tab we cannot see.
    const [verdict, setVerdict] = useState<string | null>(null)

    async function start() {
        setStarting(true)
        setError(null)
        try {
            // The draft has to exist before it can be rehearsed — a dry-run
            // is keyed by provider id. Creating it here rather than earlier
            // means an abandoned wizard leaves nothing behind until the
            // operator reaches the step that needs it.
            const row = provider ?? await onCreateDraft()
            if (!row) return
            const { loginUrl } = await ssoAdminService.startDryRun(row.id)

            // A connection whose sign-in starts with a call to the
            // provider has no session until that call is made, and the
            // tab we are about to open does not make it. Without this,
            // rehearsing a correctly configured gateway failed with
            // nothing to say which part was wrong.
            const st = (row.settings ?? {}) as Record<string, unknown>
            let handle: string | null = null
            if (
                row.kind === 'backchannel'
                && st.authenticate_enabled !== false
                && String(st.authenticate_url ?? '').trim()
            ) {
                handle = await runAuthenticateCall({
                    url: String(st.authenticate_url),
                    method: String(st.authenticate_method ?? 'POST'),
                    headers: (st.authenticate_headers ?? {}) as Record<string, string>,
                    tokenPath: String(st.authenticate_token_path ?? ''),
                })
            }

            if (
                row.kind === 'backchannel'
                && String(st.exchange_mode ?? 'server') === 'browser'
            ) {
                // Browser-mode rows: make the very call the sign-in page
                // would make — this browser holds the corporate session —
                // and rehearse the answer right here.
                const assertion = await runBrowserExchangeCall({
                    url: String(st.browser_exchange_url ?? ''),
                    method: String(st.browser_exchange_method ?? 'GET'),
                    headers: (st.browser_exchange_headers ?? {}) as Record<string, string>,
                    tokenPath: String(st.browser_exchange_token_path ?? ''),
                })
                const res = await ssoAdminService.rehearseBackchannel(
                    row.slug, { assertion },
                )
                if (!res.ok) { setError(res.line); return }
                setVerdict(res.line)
                onRehearsed()
                return
            }

            if (handle !== null) {
                // The provider answered with a handle rather than setting
                // a cookie, so an opened tab would carry nothing. Same
                // dry-run, rehearsed right here instead.
                const res = await ssoAdminService.rehearseBackchannel(
                    row.slug, { handle },
                )
                if (!res.ok) { setError(res.line); return }
                setVerdict(res.line)
                onRehearsed()
                return
            }

            window.open(loginUrl, '_blank', 'noopener')
            // The result lands in the opened tab. We cannot observe it from
            // here, so the operator confirms — which is honest about what
            // we know rather than pretending to detect success.
            onRehearsed()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setStarting(false)
        }
    }

    return (
        <StepColumn>
            <StepHero
                pill="Step 4 of 5"
                pillIcon={FlaskConical}
                title="Try it yourself, first"
                subtitle="Sign in with your own account against this connection. Nothing is written and no session is created — you'll come back here."
                tone="amber"
            />

            <StepBlock>
                <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                    <p className="text-sm text-ink">What this checks</p>
                    {kind === 'backchannel' ? (
                        <ul className="mt-2 space-y-1 text-[12px] text-ink-muted">
                            <li>• The gateway is reachable — allowlisted host, no redirects</li>
                            <li>• The token and user details are where the paths say</li>
                            <li>• Your claim mapping resolves a real person</li>
                            <li>• Which account it would create, link, or refuse</li>
                        </ul>
                    ) : (
                        <ul className="mt-2 space-y-1 text-[12px] text-ink-muted">
                            <li>• The redirect URI is registered and matches exactly</li>
                            <li>• The signature verifies against their keys</li>
                            <li>• Clocks agree closely enough</li>
                            <li>• Your claim mapping resolves a real person</li>
                            <li>• Which account it would create, link, or refuse</li>
                        </ul>
                    )}
                </div>

                <button
                    type="button"
                    onClick={() => { void start() }}
                    disabled={starting || saving}
                    className="mt-4 w-full py-3 rounded-xl bg-accent-lineage text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {starting || saving
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : rehearsed
                            ? <RefreshCw className="w-4 h-4" />
                            : <ExternalLink className="w-4 h-4" />}
                    {rehearsed ? 'Rehearse again' : 'Rehearse sign-in'}
                </button>

                {rehearsed && (
                    <div className="mt-3 flex items-start gap-2 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-300">
                        <Check className="w-4 h-4 mt-0.5 shrink-0" />
                        <div>
                            <p>{verdict ?? 'Rehearsal started in a new tab.'}</p>
                            <p className="mt-1 text-[11px] text-ink-muted">
                                {verdict
                                    ? "If that isn't who you expected, go back and adjust the mapping — this connection is still invisible to everyone else."
                                    : "Check the result there. If it isn't what you expected, go back and adjust the mapping — this connection is still invisible to everyone else."}
                            </p>
                        </div>
                    </div>
                )}

                {error && <Hint tone="warn">{error}</Hint>}
            </StepBlock>
        </StepColumn>
    )
}
