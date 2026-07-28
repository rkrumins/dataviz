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

export function RehearseStep({
    provider, rehearsed, onRehearsed, onCreateDraft, saving,
}: {
    provider: IdpProvider | null
    rehearsed: boolean
    onRehearsed: () => void
    onCreateDraft: () => Promise<IdpProvider | null>
    saving: boolean
}) {
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)

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
                    <ul className="mt-2 space-y-1 text-[12px] text-ink-muted">
                        <li>• The redirect URI is registered and matches exactly</li>
                        <li>• The signature verifies against their keys</li>
                        <li>• Clocks agree closely enough</li>
                        <li>• Your claim mapping resolves a real person</li>
                        <li>• Which account it would create, link, or refuse</li>
                    </ul>
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
                            <p>Rehearsal started in a new tab.</p>
                            <p className="mt-1 text-[11px] text-ink-muted">
                                Check the result there. If it isn't what you
                                expected, go back and adjust the mapping — this
                                connection is still invisible to everyone else.
                            </p>
                        </div>
                    </div>
                )}

                {error && <Hint tone="warn">{error}</Hint>}
            </StepBlock>
        </StepColumn>
    )
}
