/**
 * ProvidersTab — the connection list.
 *
 * One card per IdP connection, plus the first-run hero when there are
 * none and the guided wizard behind "Connect a provider".
 */
import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import {
    ssoAdminService,
    type IdpHealth,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { runAuthenticateCall } from '@/services/authService'
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
    const [showCreate, setShowCreate] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [loaded, setLoaded] = useState(false)

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
        } catch {
            setHealth({})
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
        setBusy(true)
        try {
            await ssoAdminService.updateProvider(p.id, { enabled: !p.enabled })
            await refresh()
            onChanged?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    async function publish(p: IdpProvider) {
        setBusy(true)
        try {
            await ssoAdminService.publishProvider(p.id)
            await refresh()
            onChanged?.()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
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

    /** Complete a rehearsal for the handle shape, which has no cookie
     *  for an opened tab to carry. Returns a line to show the operator —
     *  the dry-run's own verdict, not an error. */
    async function rehearseWithHandle(
        p: IdpProvider, handle: string,
    ): Promise<string> {
        const res = await fetch(
            `/api/v1/auth/${encodeURIComponent(p.slug)}/backchannel`,
            {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle }),
            },
        )
        const body = await res.json().catch(() => null)
        if (!res.ok) {
            return `Rehearsal failed: ${body?.detail?.error ?? res.status}`
        }
        const outcome = body?.outcome
        if (!outcome) return 'Rehearsal completed, but reported nothing.'
        return `Rehearsal: would sign in as ${
            outcome.email ?? outcome.externalId ?? 'an unnamed identity'
        } (${outcome.action ?? 'no action recorded'}).`
    }

    async function dryRun(p: IdpProvider) {
        if (!confirm(
            `Sign in to ${p.slug} with your own account at that IdP.\n\n` +
            'Nothing will be written and no session will be created — you ' +
            'stay signed in here, and a new tab reports what would have ' +
            'happened.',
        )) return
        setBusy(true)
        try {
            const { loginUrl } = await ssoAdminService.startDryRun(p.id)

            // A connection whose sign-in starts with a call to the
            // provider has no session until that call is made, and a new
            // tab does not make it. Rehearsing one without this opened a
            // tab that failed for a correctly configured gateway, with
            // nothing to say which part was wrong.
            const handle = await runTriggerFor(p)
            if (handle !== null) {
                // The provider answered with a handle rather than setting
                // a cookie, so there is nothing for the opened tab to
                // carry. Rehearse it here instead — the same dry-run,
                // reported inline rather than in a page we cannot see.
                setError(await rehearseWithHandle(p, handle))
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
            {error && <ErrorBanner message={error} />}

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
                        busy={busy}
                        index={i}
                        onEdit={() => setEditingId(p.id)}
                        onRehearse={() => { void dryRun(p) }}
                        onPublish={() => { void publish(p) }}
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
