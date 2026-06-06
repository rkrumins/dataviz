/**
 * MyIdentitiesPage — self-service SSO identity management.
 *
 * Lists the user's linked IdP identities (per-provider) and lets them:
 *   * link an additional provider via /api/v1/me/identities/link/{slug}/start
 *   * unlink an identity (with a 409 guard preventing lockout when this
 *     is the last way they can log in)
 *
 * Mounted at /me/identities. Requires authentication (route guarded by
 * AppLayout).
 */
import { useEffect, useState, useCallback } from 'react'
import { Link2, Unlink2, AlertCircle, Plus, Shield } from 'lucide-react'

import {
    authService,
    type IdentitiesResponse,
    type SsoProviderSummary,
    type UserIdentity,
} from '@/services/authService'

interface ErrorState {
    detail: string
}

export function MyIdentitiesPage() {
    const [data, setData] = useState<IdentitiesResponse | null>(null)
    const [providers, setProviders] = useState<SsoProviderSummary[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<ErrorState | null>(null)

    const refresh = useCallback(async () => {
        try {
            const [me, all] = await Promise.all([
                authService.listMyIdentities(),
                authService.listProviders(),
            ])
            setData(me)
            setProviders(all)
            setError(null)
        } catch (err) {
            setError({ detail: (err as Error).message })
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    if (data === null && error === null) {
        return (
            <div className="p-8 text-center text-ink-muted">Loading identities…</div>
        )
    }

    const linkedProviderIds = new Set((data?.identities ?? []).map((i) => i.provider.id))
    const linkable = providers.filter((p) => !linkedProviderIds.has(p.id))

    async function handleLink(slug: string) {
        setBusy(true)
        setError(null)
        try {
            const { loginUrl } = await authService.startIdentityLink(slug)
            window.location.href = loginUrl
        } catch (err) {
            setError({ detail: (err as Error).message })
            setBusy(false)
        }
    }

    async function handleUnlink(identity: UserIdentity) {
        if (
            !confirm(
                `Unlink ${identity.provider.displayName}? You'll need at least ` +
                `one other way to sign in (password or another SSO provider).`,
            )
        ) {
            return
        }
        setBusy(true)
        setError(null)
        try {
            await authService.unlinkMyIdentity(identity.id)
            await refresh()
        } catch (err) {
            setError({ detail: (err as Error).message })
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
        <div className="max-w-2xl mx-auto p-8 space-y-8">
            <header>
                <h1 className="text-2xl font-semibold text-ink">Connected identities</h1>
                <p className="mt-2 text-sm text-ink-secondary">
                    Each linked Identity Provider can sign you in. You can stack
                    multiple — your role and permissions stay the same regardless of
                    which one you use.
                </p>
            </header>

            {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error.detail}</span>
                </div>
            )}

            <section>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
                    <Shield className="w-3.5 h-3.5" />
                    Password
                </div>
                <div className="p-4 rounded-xl border border-white/10 bg-white/5 text-sm">
                    {data?.passwordSet
                        ? 'A password is set on this account. You can use it to sign in alongside any linked IdP.'
                        : 'No password is set. SSO is the only way you can sign in — keep at least one identity linked or add a password from your profile.'}
                </div>
            </section>

            <section>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
                    <Link2 className="w-3.5 h-3.5" />
                    Linked identities
                </div>
                {(data?.identities.length ?? 0) === 0 ? (
                    <div className="p-4 rounded-xl border border-white/10 bg-white/5 text-sm text-ink-muted">
                        No SSO providers are linked to this account yet.
                    </div>
                ) : (
                    <ul className="space-y-2">
                        {(data?.identities ?? []).map((ident) => (
                            <li
                                key={ident.id}
                                className="flex items-center justify-between p-4 rounded-xl border border-white/10 bg-white/5"
                            >
                                <div>
                                    <div className="text-sm font-medium text-ink">
                                        {ident.provider.displayName}{' '}
                                        <span className="text-ink-muted">
                                            ({ident.provider.kind})
                                        </span>
                                    </div>
                                    <div className="text-xs text-ink-muted mt-0.5 font-mono">
                                        external_id: {ident.externalId}
                                    </div>
                                    {ident.lastLoginAt && (
                                        <div className="text-xs text-ink-muted mt-0.5">
                                            last used {new Date(ident.lastLoginAt).toLocaleString()}
                                        </div>
                                    )}
                                </div>
                                <button
                                    disabled={busy}
                                    onClick={() => handleUnlink(ident)}
                                    className="px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                                >
                                    <Unlink2 className="inline w-3.5 h-3.5 mr-1" /> Unlink
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {linkable.length > 0 && (
                <section>
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
                        <Plus className="w-3.5 h-3.5" />
                        Available providers
                    </div>
                    <ul className="space-y-2">
                        {linkable.map((p) => (
                            <li
                                key={p.id}
                                className="flex items-center justify-between p-4 rounded-xl border border-white/10 bg-white/5"
                            >
                                <div className="text-sm font-medium text-ink">
                                    {p.displayName}{' '}
                                    <span className="text-ink-muted">({p.kind})</span>
                                </div>
                                <button
                                    disabled={busy}
                                    onClick={() => handleLink(p.slug)}
                                    className="px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-xs font-medium hover:brightness-110 disabled:opacity-50"
                                >
                                    <Link2 className="inline w-3.5 h-3.5 mr-1" /> Link
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
        </div>
    )
}

export default MyIdentitiesPage
