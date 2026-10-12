/**
 * MyIdentitiesPage — self-service SSO identity management.
 *
 * Lists the user's linked IdP identities and lets them link another or
 * unlink one, with a server-side 409 guard that prevents unlinking the
 * last thing that can sign them in.
 *
 * Three things were wrong here beyond the layout, and are fixed:
 *
 * **The cards were invisible in the light theme.** They used
 * `border-white/10 bg-white/5` — white on white. Those are dark-mode
 * values written as if dark were the only mode. Everything now goes
 * through the theme tokens, so both themes work.
 *
 * **Unlinking asked with `confirm()`.** A native browser dialog in an
 * app with its own dialog system, styled by the OS, unstyleable, and
 * blocking. It now asks in place.
 *
 * **It showed the raw external id.** `external_id: 00u1a2b3c4` is a
 * debugging detail; it told the person nothing about whether this was
 * the right account to unlink. The email the identity was linked with
 * answers that question, so it is shown instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Fingerprint, Link2, Plus, Unlink2 } from 'lucide-react'

import {
    AccountCard, AccountShell, EmptyState, useAccountIdentity,
} from '@/components/account/AccountShell'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import {
    authService,
    loginWithBackchannel,
    type SsoProviderSummary,
    type UserIdentity,
} from '@/services/authService'
import { gatewaySignInBody, isGatewayProvider } from '@/services/gatewayFlow'
import { useAuthStore } from '@/store/auth'

export function MyIdentitiesPage() {
    useDocumentTitle('Connected identities')

    return (
        <AccountShell
            title="Connected identities"
            blurb="The identity providers that can sign you in."
        >
            <IdentitiesContent />
        </AccountShell>
    )
}

function IdentitiesContent() {
    const { passwordSet, identities, refresh } = useAccountIdentity()
    const { notify } = useAppNotifications()
    const [providers, setProviders] = useState<SsoProviderSummary[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [confirming, setConfirming] = useState<UserIdentity | null>(null)

    const loadProviders = useCallback(async () => {
        try {
            setProviders(await authService.listProviders())
        } catch {
            // A provider list we could not load only costs the "link
            // another" section — what is already linked still renders.
        }
    }, [])

    useEffect(() => { void loadProviders() }, [loadProviders])

    const linkedIds = new Set(identities.map((i) => i.provider.id))
    const linkable = providers.filter((p) => !linkedIds.has(p.id))

    /** How many ways are left to get in. Unlinking the last one is what
     *  the server refuses, so the UI should not offer it either. */
    const signInMethods = identities.length + (passwordSet ? 1 : 0)

    async function handleLink(p: SsoProviderSummary) {
        setBusy(true)
        setError(null)
        try {
            const { loginUrl } = await authService.startIdentityLink(p.slug)
            if (!isGatewayProvider(p)) {
                window.location.href = loginUrl
                return
            }
            // A gateway row's sign-in starts with calls only this browser
            // can make — the trigger, the translate exchange — so the
            // navigation that serves the redirect kinds lands it on a
            // dead route. Run the browser half here instead; the
            // link-intent cookie startIdentityLink just set rides on the
            // POST, and the server links rather than signing in fresh.
            const body = await gatewaySignInBody(p)
            await loginWithBackchannel(p.slug, body)
            await refresh()
            notify('success', `${p.displayName} linked`)
            // The link can change what SSO-governed groups grant; pick
            // the new claims up now rather than at the next rotation.
            try {
                await useAuthStore.getState().refreshPermissions()
            } catch {
                // best-effort — the linked row is already showing
            }
            setBusy(false)
        } catch (err) {
            setError((err as Error).message)
            setBusy(false)
        }
    }

    async function handleUnlink(identity: UserIdentity) {
        setBusy(true)
        setError(null)
        try {
            await authService.unlinkMyIdentity(identity.id)
            await refresh()
            notify('success', `${identity.provider.displayName} unlinked`)
            setConfirming(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <AccountCard
                icon={Link2}
                title="Linked identities"
                blurb="Any of these can sign you in. Your role and permissions are the same whichever you use."
            >
                {identities.length === 0 ? (
                    <EmptyState icon={Fingerprint}>
                        No identity providers are linked to this account yet.
                    </EmptyState>
                ) : (
                    <ul className="space-y-2">
                        {identities.map((ident) => (
                            <li
                                key={ident.id}
                                className="rounded-xl border border-glass-border bg-canvas p-4"
                            >
                                <div className="flex items-center justify-between gap-4 flex-wrap">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-ink">
                                                {ident.provider.displayName}
                                            </span>
                                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border border-glass-border">
                                                {ident.provider.kind}
                                            </span>
                                        </div>
                                        <p className="text-xs text-ink-muted mt-1">
                                            {ident.emailAtLink
                                                ? `Linked as ${ident.emailAtLink}`
                                                : 'Linked to this account'}
                                            {ident.lastLoginAt && (
                                                <> · last used {new Date(ident.lastLoginAt).toLocaleDateString()}</>
                                            )}
                                        </p>
                                    </div>

                                    {confirming?.id === ident.id ? (
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => setConfirming(null)}
                                                disabled={busy}
                                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => handleUnlink(ident)}
                                                disabled={busy}
                                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                                            >
                                                {busy ? 'Unlinking…' : 'Yes, unlink'}
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => { setError(null); setConfirming(ident) }}
                                            disabled={busy || signInMethods <= 1}
                                            title={
                                                signInMethods <= 1
                                                    ? 'This is the only way you can sign in.'
                                                    : undefined
                                            }
                                            className={cn(
                                                'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                                'border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-500/10',
                                                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                                                'inline-flex items-center gap-1.5',
                                            )}
                                        >
                                            <Unlink2 className="w-3.5 h-3.5" />
                                            Unlink
                                        </button>
                                    )}
                                </div>

                                {confirming?.id === ident.id && (
                                    <p className="text-xs text-ink-muted mt-3 pt-3 border-t border-glass-border">
                                        You will no longer be able to sign in with{' '}
                                        {ident.provider.displayName}. You have{' '}
                                        {signInMethods - 1} other way
                                        {signInMethods - 1 === 1 ? '' : 's'} to sign in.
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </AccountCard>

            {linkable.length > 0 && (
                <AccountCard
                    icon={Plus}
                    title="Link another"
                    blurb="Adds a way to sign in. It does not change what you can access."
                >
                    <ul className="space-y-2">
                        {linkable.map((p) => (
                            <li
                                key={p.id}
                                className="flex items-center justify-between gap-4 rounded-xl border border-glass-border bg-canvas p-4"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-medium text-ink truncate">
                                        {p.displayName}
                                    </span>
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border border-glass-border shrink-0">
                                        {p.kind}
                                    </span>
                                </div>
                                <button
                                    disabled={busy}
                                    onClick={() => handleLink(p)}
                                    className="shrink-0 px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-xs font-semibold hover:brightness-110 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                                >
                                    <Link2 className="w-3.5 h-3.5" />
                                    Link
                                </button>
                            </li>
                        ))}
                    </ul>
                </AccountCard>
            )}
        </>
    )
}

export default MyIdentitiesPage
