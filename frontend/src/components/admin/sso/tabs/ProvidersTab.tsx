/**
 * ProvidersTab — the connection list.
 *
 * One card per IdP connection, plus the first-run hero when there are
 * none and the guided wizard behind "Connect a provider".
 */
import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, Power, X } from 'lucide-react'
import {
    ssoAdminService,
    summarizeRehearsalOutcome,
    type IdpHealth,
    type IdpProvider,
} from '@/services/ssoAdminService'
import {
    runAuthenticateCall,
    runBrowserExchangeCall,
} from '@/services/authService'
import { SsoFirstRunHero } from '../SsoFirstRunHero'
import { IdpProviderCard } from '../IdpProviderCard'
import { IdpConnectionWizard } from '../IdpConnectionWizard'
import { ProviderEditorDrawer } from '../ProviderEditorDrawer'
import { SsoCard, SsoEmpty } from '../ui/SsoCard'
import { SsoListSkeleton, SsoLoading } from '../ui/SsoSkeleton'
import { ErrorBanner } from './ErrorBanner'

export function ProvidersTab({
    openWizardSignal = 0, filter = null, onClearFilter, onChanged,
}: {
    /** Bumped by the page's "Connect a provider" action. A counter rather
     *  than a boolean so a second press re-opens after a cancel. */
    openWizardSignal?: number
    /** Set by the page's "Drafts to rehearse" tile. */
    filter?: 'drafts' | null
    onClearFilter?: () => void
    /** Lets the page's stat tiles follow a change made in here. */
    onChanged?: () => void
} = {}) {
    const [rows, setRows] = useState<IdpProvider[]>([])
    const [health, setHealth] = useState<Record<string, IdpHealth>>({})
    const [error, setError] = useState<string | null>(null)
    // A rehearsal's verdict is a result, not a failure — it gets its own
    // surface. Rendering "would sign in as ada@…" in the error banner
    // taught operators that a working connection was broken.
    const [notice, setNotice] = useState<string | null>(null)
    const [showCreate, setShowCreate] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    // Which card's which action is in flight — so the control actually
    // working can show a spinner, instead of every control on every
    // card greying out identically.
    const [pending, setPending] = useState<{
        id: string
        action: 'toggle' | 'publish' | 'rehearse'
    } | null>(null)
    // A failed status read is a different fact from "never probed", and
    // rendering them identically made an outage look like a fresh
    // install.
    const [healthUnavailable, setHealthUnavailable] = useState(false)
    // The platform master switch. When it is off, no connection signs
    // anyone in — whatever the cards say — so the list says so.
    const [ssoMasterOff, setSsoMasterOff] = useState(false)
    const [loaded, setLoaded] = useState(false)
    // Turning a connection OFF gets a confirm with a number in it: how
    // many people are signed in through it right now, and whether to
    // sign them out too. ``count === null`` means the count could not be
    // read — the confirm still happens, just numberless.
    const [disabling, setDisabling] = useState<{
        provider: IdpProvider
        count: number | null
        signOut: boolean
    } | null>(null)
    // Publish and rehearse ask in the same breath as disable does — one
    // inline confirm idiom for every consequential action, instead of a
    // browser confirm() for one and an unguarded click for the other.
    const [publishing, setPublishing] = useState<IdpProvider | null>(null)
    const [rehearsing, setRehearsing] = useState<IdpProvider | null>(null)

    const refresh = useCallback(async () => {
        try {
            setRows(await ssoAdminService.listProviders())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setLoaded(true)
        }
        // Health is a separate, non-fatal read: it comes from a background
        // sweep, so a replica that runs no schedulers returns nothing and the
        // provider list must still render.
        try {
            const status = await ssoAdminService.providerStatus()
            setHealth(Object.fromEntries(
                status.providers.map((h) => [h.providerId, h]),
            ))
            setHealthUnavailable(false)
        } catch {
            setHealth({})
            setHealthUnavailable(true)
        }
        // The posture read is supplementary too — the list must render
        // without it, and absence of the banner is the safe default.
        try {
            const cfg = await ssoAdminService.getAuthConfig()
            setSsoMasterOff(!cfg.ssoEnabled)
        } catch {
            setSsoMasterOff(false)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    // Skip the initial 0 so the wizard does not open on first paint.
    useEffect(() => {
        if (openWizardSignal > 0) setShowCreate(true)
    }, [openWizardSignal])

    // Resolved from the freshest list rather than held as a snapshot, so a
    // refresh behind the open drawer does not leave it editing a stale row.
    const editing = rows.find(p => p.id === editingId) ?? null

    async function toggleEnabled(p: IdpProvider) {
        if (p.enabled) {
            // Disabling stops new sign-ins but the sessions it already
            // minted keep rotating until they expire — so ask, with the
            // count, and offer to end them now. The count is best-effort.
            setBusy(true)
            setPending({ id: p.id, action: 'toggle' })
            let count: number | null = null
            try {
                const dry = await ssoAdminService.endProviderSessions(
                    p.id, { dryRun: true },
                )
                count = dry.usersAffected
            } catch {
                count = null
            } finally {
                setBusy(false)
                setPending(null)
            }
            setPublishing(null)
            setRehearsing(null)
            setDisabling({ provider: p, count, signOut: false })
            return
        }
        setBusy(true)
        setPending({ id: p.id, action: 'toggle' })
        try {
            await ssoAdminService.updateProvider(p.id, { enabled: true })
            await refresh()
            onChanged?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
            setPending(null)
        }
    }

    async function confirmDisable() {
        if (!disabling) return
        const { provider: p, signOut } = disabling
        setBusy(true)
        setPending({ id: p.id, action: 'toggle' })
        try {
            await ssoAdminService.updateProvider(p.id, { enabled: false })
        } catch (err) {
            setError((err as Error).message)
            setBusy(false)
            setPending(null)
            return
        }
        let ended: { usersAffected: number } | null = null
        let endFailure: string | null = null
        if (signOut) {
            try {
                ended = await ssoAdminService.endProviderSessions(p.id)
            } catch (err) {
                endFailure = (err as Error).message
            }
        }
        setDisabling(null)
        // refresh() clears the error banner on success, so the outcome
        // message has to land after it, not before.
        await refresh()
        onChanged?.()
        if (endFailure !== null) {
            // The switch DID flip — say so, and say what didn't happen.
            setError(
                `${p.displayName} is off, but signing its users out `
                + `failed: ${endFailure}`,
            )
        } else if (ended !== null) {
            setNotice(
                `${p.displayName} is off. Signed out `
                + `${ended.usersAffected} ${
                    ended.usersAffected === 1 ? 'person' : 'people'
                } who had signed in through it.`,
            )
        } else {
            setNotice(
                `${p.displayName} is off. People already signed in through `
                + 'it keep their sessions until those expire.',
            )
        }
        setBusy(false)
        setPending(null)
    }

    async function publish(p: IdpProvider) {
        setBusy(true)
        setPending({ id: p.id, action: 'publish' })
        try {
            await ssoAdminService.publishProvider(p.id)
            await refresh()
            onChanged?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
            setPending(null)
        }
    }

    /** Run a connection's sign-in trigger, or nothing if it has none.
     *  Returns the handle it answered with, or null when it worked by
     *  setting a cookie — and null, too, when there is no trigger at
     *  all, which is the ordinary case. */
    async function runTriggerFor(p: IdpProvider): Promise<string | null> {
        const st = (p.settings ?? {}) as Record<string, unknown>
        if (p.kind !== 'backchannel') return null
        if (st.authenticate_enabled === false) return null
        if (!String(st.authenticate_url ?? '').trim()) return null
        return runAuthenticateCall({
            url: String(st.authenticate_url),
            method: String(st.authenticate_method ?? 'POST'),
            headers: (st.authenticate_headers ?? {}) as Record<string, string>,
            tokenPath: String(st.authenticate_token_path ?? ''),
        })
    }

    async function dryRun(p: IdpProvider) {
        setBusy(true)
        setPending({ id: p.id, action: 'rehearse' })
        setNotice(null)
        try {
            const { loginUrl } = await ssoAdminService.startDryRun(p.id)
            const st = (p.settings ?? {}) as Record<string, unknown>

            // A connection whose sign-in starts with a call to the
            // provider has no session until that call is made, and a new
            // tab does not make it. Rehearsing one without this opened a
            // tab that failed for a correctly configured gateway, with
            // nothing to say which part was wrong.
            const handle = await runTriggerFor(p)

            // Verdicts render the group story too — who, and what would
            // be granted — since that is what an operator rehearsing a
            // mapping is actually debugging.
            const report = (verdict: {
                ok: boolean
                line: string
                outcome?: Parameters<typeof summarizeRehearsalOutcome>[0]
            }) => {
                const text = verdict.outcome
                    ? [verdict.line,
                       ...summarizeRehearsalOutcome(verdict.outcome)].join('\n')
                    : verdict.line
                ;(verdict.ok ? setNotice : setError)(text)
            }

            if (p.kind === 'backchannel'
                && String(st.exchange_mode ?? 'server') === 'browser') {
                // Browser-mode rows: make the very call the sign-in page
                // would make — this browser holds the corporate cookie —
                // and rehearse the answer inline.
                const assertion = await runBrowserExchangeCall({
                    url: String(st.browser_exchange_url ?? ''),
                    method: String(st.browser_exchange_method ?? 'GET'),
                    headers: (st.browser_exchange_headers ?? {}) as Record<string, string>,
                    tokenPath: String(st.browser_exchange_token_path ?? ''),
                    bodyField: String(st.browser_exchange_body_field ?? ''),
                    token: handle,
                })
                report(await ssoAdminService.rehearseBackchannel(
                    p.slug, { assertion },
                ))
                return
            }

            if (handle !== null) {
                // The provider answered with a handle rather than setting
                // a cookie, so there is nothing for the opened tab to
                // carry. Rehearse it here instead — the same dry-run,
                // reported inline rather than in a page we cannot see.
                report(await ssoAdminService.rehearseBackchannel(
                    p.slug, { handle },
                ))
                return
            }

            window.open(loginUrl, '_blank', 'noopener')
        } catch (err) {
            setError(
                `Could not start the sign-in for ${p.displayName}: `
                + (err as Error).message,
            )
        } finally {
            setBusy(false)
            setPending(null)
        }
    }

    if (!loaded) {
        // Without this the empty `rows` on first paint rendered the
        // first-run hero for one frame, so an org with six connections
        // was briefly told it had none.
        return (
            <>
                <SsoLoading label="Loading connections" />
                <SsoListSkeleton />
            </>
        )
    }

    if (rows.length === 0 && !showCreate && !error) {
        // An empty table with a button above it says nothing about what
        // the job is. Replace the empty surface with the path through it.
        return <SsoFirstRunHero onStart={() => setShowCreate(true)} />
    }

    const visible = filter === 'drafts'
        ? rows.filter(p => p.lifecycle === 'draft')
        : rows

    return (
        <div className="space-y-4">
            {ssoMasterOff && (
                <div
                    role="status"
                    className="flex items-start gap-2 px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06]"
                >
                    <Power className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                    <p className="text-xs text-ink flex-1 min-w-0">
                        The SSO master switch is off — no connection signs
                        anyone in right now, whatever the cards below say.
                        Turn it back on under the Settings tab.
                    </p>
                </div>
            )}
            {error && <ErrorBanner message={error} />}
            {notice && (
                <div
                    role="status"
                    className="flex items-start gap-2 px-3 py-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06]"
                >
                    <FlaskConical className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                    <p className="text-xs text-ink flex-1 min-w-0 whitespace-pre-line">{notice}</p>
                    <button
                        type="button"
                        aria-label="Dismiss notice"
                        onClick={() => setNotice(null)}
                        className="shrink-0 text-ink-muted hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {disabling && (
                <div
                    role="alertdialog"
                    aria-label={`Turn off ${disabling.provider.displayName}?`}
                    className="px-3 py-3 rounded-xl border border-red-500/30 bg-red-500/[0.05] space-y-2"
                >
                    <p className="text-xs text-ink leading-relaxed">
                        Turn off <strong>{disabling.provider.displayName}</strong>?
                        {' '}New sign-ins through it stop immediately.{' '}
                        {disabling.count === null
                            ? 'People already signed in through it keep their sessions until those expire.'
                            : disabling.count === 0
                                ? 'Nobody is currently signed in through it.'
                                : `${disabling.count} ${
                                    disabling.count === 1
                                        ? 'person keeps their session'
                                        : 'people keep their sessions'
                                } until those expire.`}
                    </p>
                    {(disabling.count === null || disabling.count > 0) && (
                        <label className="flex items-center gap-2 text-xs text-ink">
                            <input
                                type="checkbox"
                                checked={disabling.signOut}
                                onChange={e => {
                                    const signOut = e.target.checked
                                    setDisabling(d => d && { ...d, signOut })
                                }}
                            />
                            {disabling.count === null
                                ? 'Also sign those people out now'
                                : `Also sign ${
                                    disabling.count === 1
                                        ? 'that person'
                                        : `those ${disabling.count} people`
                                } out now`}
                        </label>
                    )}
                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={() => void confirmDisable()}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                        >
                            Turn it off
                        </button>
                        <button
                            type="button"
                            onClick={() => setDisabling(null)}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Keep it on
                        </button>
                    </div>
                </div>
            )}

            {publishing && (
                <div
                    role="alertdialog"
                    aria-label={`Publish ${publishing.displayName}?`}
                    className="px-3 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] space-y-2"
                >
                    <p className="text-xs text-ink leading-relaxed">
                        Publish <strong>{publishing.displayName}</strong>?
                        {' '}It goes in front of everyone on the sign-in
                        page, immediately.{' '}
                        {publishing.lastAssertionAt
                            ? 'It has been rehearsed — a sign-in has already completed against this configuration.'
                            : 'It has never been rehearsed — nothing has confirmed a sign-in against this configuration yet.'}
                    </p>
                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={() => {
                                const p = publishing
                                setPublishing(null)
                                void publish(p)
                            }}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-xs font-medium hover:brightness-110 disabled:opacity-50"
                        >
                            Publish it
                        </button>
                        <button
                            type="button"
                            onClick={() => setPublishing(null)}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Not yet
                        </button>
                    </div>
                </div>
            )}

            {rehearsing && (
                <div
                    role="alertdialog"
                    aria-label={`Rehearse ${rehearsing.displayName}?`}
                    className="px-3 py-3 rounded-xl border border-glass-border bg-canvas-elevated space-y-2"
                >
                    <p className="text-xs text-ink leading-relaxed">
                        Sign in to <strong>{rehearsing.slug}</strong> with
                        your own account at that IdP. Nothing will be
                        written and no session will be created — you stay
                        signed in here, and what would have happened is
                        reported on this page or in a new tab.
                    </p>
                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={() => {
                                const p = rehearsing
                                setRehearsing(null)
                                void dryRun(p)
                            }}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-xs font-medium hover:brightness-110 disabled:opacity-50"
                        >
                            Rehearse
                        </button>
                        <button
                            type="button"
                            onClick={() => setRehearsing(null)}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {filter === 'drafts' && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.05]">
                    <FlaskConical className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                    <p className="text-xs text-ink flex-1 min-w-0">
                        Showing drafts only — nobody can see these on the sign-in
                        page until you publish them.
                    </p>
                    <button
                        type="button"
                        onClick={onClearFilter}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5 transition-colors duration-150"
                    >
                        <X className="w-3 h-3" />
                        Show all
                    </button>
                </div>
            )}

            {/* No heading row of its own: the counts are the page's stat
                tiles now, and "Connect a provider" is a page action beside
                Refresh, where every other Admin section puts it. */}
            <div className="space-y-3">
                {visible.map((p, i) => (
                    <IdpProviderCard
                        key={p.id}
                        provider={p}
                        health={health[p.id]}
                        healthUnavailable={healthUnavailable}
                        busy={busy}
                        pending={pending?.id === p.id ? pending.action : null}
                        index={i}
                        onEdit={() => setEditingId(p.id)}
                        onRehearse={() => {
                            setDisabling(null)
                            setPublishing(null)
                            setRehearsing(p)
                        }}
                        onPublish={() => {
                            setDisabling(null)
                            setRehearsing(null)
                            setPublishing(p)
                        }}
                        onToggleEnabled={() => { void toggleEnabled(p) }}
                        // Deleting now lives in the editor's danger zone,
                        // behind a type-to-confirm, rather than one browser
                        // confirm() away from the list.
                        onDelete={() => setEditingId(p.id)}
                    />
                ))}
            </div>

            {/* Reachable by publishing the last draft while filtered — the
                list would otherwise just vanish. */}
            {visible.length === 0 && (
                <SsoCard>
                    <SsoEmpty
                        icon={FlaskConical}
                        action={
                            <button
                                type="button"
                                onClick={onClearFilter}
                                className="px-4 py-2 rounded-xl border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 text-sm font-medium text-ink transition-colors duration-150"
                            >
                                Show all connections
                            </button>
                        }
                    >
                        Nothing is in draft — every connection is published.
                    </SsoEmpty>
                </SsoCard>
            )}

            {editing && (
                <ProviderEditorDrawer
                    provider={editing}
                    onClose={() => setEditingId(null)}
                    onSaved={() => { void refresh(); onChanged?.() }}
                    onDeleted={() => { setEditingId(null); void refresh(); onChanged?.() }}
                />
            )}

            {showCreate && (
                <IdpConnectionWizard
                    onClose={() => { setShowCreate(false); void refresh() }}
                    onPublished={() => { void refresh(); onChanged?.() }}
                />
            )}
        </div>
    )
}
