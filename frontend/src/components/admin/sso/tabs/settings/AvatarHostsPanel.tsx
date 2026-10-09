/**
 * Which external sites in-app avatars may be fetched from.
 *
 * When a connection maps a profile-picture URL from the claims, OUR
 * server fetches the image at sign-in and re-serves it from this origin
 * (browsers never load the remote URL, so member lists cannot leak
 * viewers to the photo host). This list is the on-switch for external
 * sources: with it empty, an avatar URL pointing at the public internet
 * is refused by name — nothing outside your network is fetched until
 * you say so, host by host.
 *
 * The copy is the feature as much as the form is: the person
 * configuring this needs to know what qualifies (raster image URLs),
 * what happens to redirects, and where private hosts belong instead.
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

export function AvatarHostsPanel() {
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
            setHosts(await ssoAdminService.listBackchannelHosts('avatar'))
            setError(null)
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // Same separately-granted permission as the gateway list —
            // an admin who can edit everything else here may not hold
            // it, and that is a fact to state, not a fault to report.
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
            }, 'avatar')
            setHost(''); setPort('443'); setNote('')
            await refresh()
            notify('success',
                `${entry} is allowed — avatars can be fetched from it now.`)
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
            notify('success',
                `${named} is withdrawn — no avatar is fetched from it now.`)
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
            <SsoSectionLabel>Avatar image hosts</SsoSectionLabel>

            <SsoCard tone="neutral">
                <p className="text-[12px] text-ink-muted leading-relaxed">
                    When a connection maps profile pictures from its claims,
                    this server fetches each image once at sign-in and shows
                    it from here — people&rsquo;s browsers never load the
                    external site. External avatars are off until a host is
                    listed: an avatar URL pointing anywhere not on this list
                    is refused, and the rehearsal names the host to add.
                </p>
                <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                    What gets through: raster image URLs only — PNG, JPEG,
                    GIF, WebP or AVIF, up to 256&nbsp;KiB. A raster image is
                    a grid of pixels, a finished picture; SVG files (drawing
                    instructions that can carry scripts) and web pages are
                    refused. Redirects are followed up to three hops, and
                    every host in the chain must be listed here. A private
                    host inside your own network belongs on the
                    internal-gateways list above instead.
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
                                    Nothing listed — external avatars are off.
                                    Mapped avatar URLs on outside hosts are
                                    refused until their host is added here.
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
                                placeholder="avatars.example.com"
                                aria-label="Avatar image host"
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
