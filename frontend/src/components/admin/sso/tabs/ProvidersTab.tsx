/**
 * ProvidersTab — the connection list.
 *
 * One card per IdP connection, plus the first-run hero when there are
 * none and the guided wizard behind "Connect a provider".
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'

import {
    ssoAdminService,
    type IdpHealth,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { ProviderForm } from '../../ProviderForm'
import { DocsLink } from '@/components/help/DocsLink'
import { SsoFirstRunHero } from '../SsoFirstRunHero'
import { IdpProviderCard } from '../IdpProviderCard'
import { IdpConnectionWizard } from '../IdpConnectionWizard'
import { ErrorBanner } from './ErrorBanner'

export function ProvidersTab() {
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

    async function toggleEnabled(p: IdpProvider) {
        setBusy(true)
        try {
            await ssoAdminService.updateProvider(p.id, { enabled: !p.enabled })
            await refresh()
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

    async function remove(p: IdpProvider) {
        if (!confirm(`Delete provider ${p.slug}? Linked users must unlink first.`)) return
        setBusy(true)
        try {
            await ssoAdminService.deleteProvider(p.id)
            await refresh()
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
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-base font-semibold">Connections</h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                        {rows.filter(p => p.lifecycle !== 'draft').length} live
                        {rows.some(p => p.lifecycle === 'draft') &&
                            `, ${rows.filter(p => p.lifecycle === 'draft').length} draft`}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <DocsLink slug="sso-setup" variant="icon" />
                    <button
                        onClick={() => setShowCreate(true)}
                        className="px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-sm flex items-center gap-1"
                    >
                        <Plus className="w-4 h-4" />
                        Connect a provider
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                {rows.map((p, i) => (
                    <Fragment key={p.id}>
                        <IdpProviderCard
                            provider={p}
                            health={health[p.id]}
                            busy={busy}
                            index={i}
                            onEdit={() => setEditingId(editingId === p.id ? null : p.id)}
                            onRehearse={() => { void dryRun(p) }}
                            onPublish={() => { void publish(p) }}
                            onToggleEnabled={() => { void toggleEnabled(p) }}
                            onDelete={() => { void remove(p) }}
                        />
                        {editingId === p.id && (
                            <ProviderForm
                                existing={p}
                                onSaved={() => { setEditingId(null); void refresh() }}
                                onError={setError}
                                onCancel={() => setEditingId(null)}
                            />
                        )}
                    </Fragment>
                ))}
            </div>

            {showCreate && (
                <IdpConnectionWizard
                    onClose={() => { setShowCreate(false); void refresh() }}
                    onPublished={() => { void refresh() }}
                />
            )}
        </div>
    )
}
