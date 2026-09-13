/**
 * Which internal addresses SSO is allowed to call.
 *
 * The outbound guard refuses every private address, which is right for
 * IdP metadata — published on the public internet — and fatal for an
 * enterprise gateway, which is internal by definition. This list is the
 * exception, and it is the only thing standing between a provider
 * settings form and a tool for making requests into your own network.
 *
 * So the panel is written to be *readable by an auditor*, not merely
 * usable by the person adding a host: every entry shows its port and
 * who added it, because the argument for editing this from a browser at
 * all is that each entry is attributable and individually revocable.
 *
 * It lives on the posture tab rather than inside a provider's settings
 * because a per-provider allowlist would be circular — "the URL you
 * typed is permitted" is not a control.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react'

import {
    ssoAdminService, type BackchannelHost,
} from '@/services/ssoAdminService'
import { SsoCard, SsoSectionLabel } from '../../ui/SsoCard'
import { useAppNotifications } from '@/components/ui/notifications'
import { ErrorBanner } from '../ErrorBanner'

const inputCls =
    'px-3 py-2 text-sm rounded-xl border-2 border-black/[0.10] ' +
    'dark:border-white/[0.12] bg-canvas-elevated text-ink outline-none ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

export function BackchannelHostsPanel() {
    const [hosts, setHosts] = useState<BackchannelHost[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [forbidden, setForbidden] = useState(false)
    const [host, setHost] = useState('')
    const [port, setPort] = useState('443')
    const [note, setNote] = useState('')
    const [busy, setBusy] = useState(false)
    const { notify } = useAppNotifications()

    const refresh = useCallback(async () => {
        try {
            setHosts(await ssoAdminService.listBackchannelHosts())
            setError(null)
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // A 403 here is not a fault to report as one: this list has
            // its own permission, so an admin who can edit everything
            // else on this page may legitimately not hold it. Saying
            // that is more useful than an empty list or a red banner.
            if (/forbidden|permission|403/i.test(message)) {
                setForbidden(true)
                setHosts([])
                return
            }
            setError(message)
        }
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    const add = async () => {
        // Named before the fields are cleared, and this is a change to
        // where the deployment may send requests — it says so out loud
        // rather than leaving a re-rendered list to be noticed.
        const entry = `${host.trim()}:${Number(port) || 443}`
        setBusy(true)
        try {
            await ssoAdminService.addBackchannelHost({
                host: host.trim(),
                port: Number(port) || 443,
                note: note.trim() || undefined,
            })
            setHost(''); setPort('443'); setNote('')
            await refresh()
            notify('success', `${entry} is allowed — sign-in can call it now.`)
        } catch (e) {
            notify('error', e instanceof Error && e.message
                ? e.message
                : `Could not allow ${entry}.`)
        } finally {
            setBusy(false)
        }
    }

    const remove = async (entry: BackchannelHost) => {
        const named = `${entry.host}:${entry.port}`
        setBusy(true)
        try {
            await ssoAdminService.deleteBackchannelHost(entry.id)
            await refresh()
            notify('success', `${named} is withdrawn — sign-in can no longer call it.`)
        } catch (e) {
            notify('error', e instanceof Error && e.message
                ? e.message
                : `Could not withdraw ${named}.`)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-3">
            <SsoSectionLabel>Internal gateways SSO may call</SsoSectionLabel>

            <SsoCard tone="neutral">
                <p className="text-[12px] text-ink-muted leading-relaxed">
                    An enterprise gateway provider signs people in by calling
                    a service inside your network. Nothing here is reachable
                    until its host is listed, and every entry is a
                    destination this deployment will make requests to — so
                    add only the gateways you meant to, and take them off
                    when they are decommissioned.
                </p>
                <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                    The port is part of the entry: allowing a gateway on 443
                    does not allow anything else answering on the same
                    machine. Loopback and cloud metadata addresses are
                    refused whatever is listed here. This list is about your
                    own network — external avatar image sites are governed
                    by the separate list below, not by entries here.
                </p>

                {forbidden ? (
                    <div className="mt-3 flex items-start gap-2 text-[12px] text-amber-300">
                        <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>
                            You don&rsquo;t have permission to see or change this
                            list. It is granted separately from platform
                            administration, because it decides where this
                            deployment may send requests.
                        </span>
                    </div>
                ) : (
                    <>
                        <div className="mt-4 space-y-2">
                            {hosts === null && (
                                <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                            )}
                            {hosts?.length === 0 && (
                                <p className="text-[12px] text-ink-muted">
                                    Nothing listed. Enterprise gateway
                                    providers cannot reach anything internal
                                    yet.
                                </p>
                            )}
                            {hosts?.map(entry => (
                                <div
                                    key={entry.id}
                                    className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]"
                                >
                                    <span className="font-mono text-xs text-ink">
                                        {entry.host}:{entry.port}
                                    </span>
                                    {entry.note && (
                                        <span className="text-[11px] text-ink-muted truncate">
                                            {entry.note}
                                        </span>
                                    )}
                                    <span className="ml-auto text-[11px] text-ink-muted">
                                        {entry.createdBy ? `added by ${entry.createdBy}` : ''}
                                    </span>
                                    <button
                                        type="button"
                                        aria-label={`Remove ${entry.host}:${entry.port}`}
                                        disabled={busy}
                                        onClick={() => void remove(entry)}
                                        className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                            <input
                                className={`${inputCls} font-mono text-xs flex-1 min-w-[14rem]`}
                                value={host}
                                onChange={e => setHost(e.target.value)}
                                placeholder="sso-gateway.corp.internal"
                                aria-label="Gateway host"
                            />
                            <input
                                className={`${inputCls} font-mono text-xs w-24`}
                                value={port}
                                onChange={e => setPort(e.target.value)}
                                placeholder="443"
                                aria-label="Port"
                            />
                            <input
                                className={`${inputCls} flex-1 min-w-[10rem]`}
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                placeholder="what this is (optional)"
                                aria-label="Note"
                            />
                            <button
                                type="button"
                                disabled={busy || !host.trim()}
                                onClick={() => void add()}
                                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-accent-lineage text-white text-sm font-semibold disabled:opacity-40"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Allow
                            </button>
                        </div>
                    </>
                )}
            </SsoCard>

            {error && <ErrorBanner message={error} />}
        </div>
    )
}
