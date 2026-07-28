/**
 * ProvidersTab — the connection list.
 *
 * One card per IdP connection, plus the first-run hero when there are
 * none and the guided wizard behind "Connect a provider".
 */
import { useCallback, useEffect, useState } from 'react'
import {
    ssoAdminService,
    type IdpHealth,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { SsoFirstRunHero } from '../SsoFirstRunHero'
import { IdpProviderCard } from '../IdpProviderCard'
import { IdpConnectionWizard } from '../IdpConnectionWizard'
import { ProviderEditorDrawer } from '../ProviderEditorDrawer'
import { ErrorBanner } from './ErrorBanner'

export function ProvidersTab({
    openWizardSignal = 0, onChanged,
}: {
    /** Bumped by the page's "Connect a provider" action. A counter rather
     *  than a boolean so a second press re-opens after a cancel. */
    openWizardSignal?: number
    /** Lets the page's stat tiles follow a change made in here. */
    onChanged?: () => void
} = {}) {
    const [rows, setRows] = useState<IdpProvider[]>([])
    const [health, setHealth] = useState<Record<string, IdpHealth>>({})
    const [error, setError] = useState<string | null>(null)
    const [showCreate, setShowCreate] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback(async () => {
        try {
            setRows(await ssoAdminService.listProviders())
            setError(null)
        } catch (err) {
            setError((err as Error).message)
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
            window.open(loginUrl, '_blank', 'noopener')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    if (rows.length === 0 && !showCreate && !error) {
        // An empty table with a button above it says nothing about what
        // the job is. Replace the empty surface with the path through it.
        return <SsoFirstRunHero onStart={() => setShowCreate(true)} />
    }

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            {/* No heading row of its own: the counts are the page's stat
                tiles now, and "Connect a provider" is a page action beside
                Refresh, where every other Admin section puts it. */}
            <div className="space-y-3">
                {rows.map((p, i) => (
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
