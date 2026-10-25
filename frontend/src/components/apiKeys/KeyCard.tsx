/**
 * One key, answering what a person asks of a key they may have forgotten:
 * what it can do and on what, when it stops, when it was last used and from
 * where, and how much — with the next thing to do with it one click away.
 *
 * Revoking asks once, in place: the button becomes the question.
 *
 * `PastKeyRow` is the compact line for a key that has ended. An expired key
 * that something still calls gets more than a line — whatever calls it is
 * failing right now — and the way to bring it back.
 */
import { useState } from 'react'
import {
    Ban, ChevronRight, Database, Eye, Globe, KeySquare, Layers, LogIn, Megaphone,
    Network, PauseCircle, Pencil, RotateCw, Trash2, TriangleAlert,
} from 'lucide-react'

import { Chip } from '@/components/account/AccountShell'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { HoverTip } from '@/components/ui/HoverTip'
import { Sparkline } from '@/components/ui/Sparkline'
import { cn } from '@/lib/utils'
import type { ApiKey } from '@/services/apiKeyService'
import {
    describeLastUsed, describeResources, describeRevocation, expiryCountdown, formatDay, stillCalled,
} from './apiKeyFormat'
import { ExpiryFact, KeyStatusBadge } from './parts'

const LEVEL = { none: 'none', read: 'read', write: 'read & write' } as const

/** The key's limits as chips: what it may do, on what, from where. */
export function KeyChips({ apiKey: key }: { apiKey: Pick<ApiKey, 'permissions' | 'resources' | 'allowedCidrs'> }) {
    const p = key.permissions
    return (
        <div className="flex flex-wrap gap-1.5">
            {p.views !== 'none' && <Chip icon={Eye} label={`Views: ${LEVEL[p.views]}`} />}
            {p.data !== 'none' && <Chip icon={Database} label={`Data: ${LEVEL[p.data]}`} />}
            {p.publish && <Chip icon={Megaphone} label="Publishes" tone="warn" />}
            <Chip
                icon={key.resources === 'all' ? Globe : Layers}
                label={describeResources(key.resources)}
                tone={key.resources === 'all' ? 'warn' : 'neutral'}
            />
            <Chip
                icon={Network}
                label={key.allowedCidrs.length > 0 ? `Only from ${key.allowedCidrs.join(', ')}` : 'Any network'}
            />
        </div>
    )
}

/** The secondary button's own edge is a white hairline in light mode — none at all on a white card. */
const EDGE_BUTTON = 'border-black/[0.10] dark:border-white/[0.12] shadow-sm'

const TILE = {
    active: 'from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/20',
    paused: 'from-amber-400 to-amber-500 text-white shadow-md shadow-amber-500/20',
    ended: 'from-slate-200 to-slate-300 text-slate-500 dark:from-slate-700 dark:to-slate-800 dark:text-slate-300',
}

export function KeyCard({ apiKey: key, resume, onOpen, onRotate, onEdit, onRevoke }: {
    apiKey: ApiKey
    /** A paused key resumes when its owner signs in again: where, and through what. */
    resume?: { url: string | null; provider: string }
    onOpen: () => void
    onRotate?: () => void
    onEdit?: () => void
    onRevoke?: () => void
}) {
    const [confirming, setConfirming] = useState(false)
    const lastUsed = describeLastUsed(key)
    const daily = key.usage.daily14
    const fortnight = daily.reduce((n, v) => n + v, 0)
    const busiest = Math.max(...daily)

    return (
        <li className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-indigo-500/30 dark:hover:border-indigo-400/30">
            <div className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3">
                    <span className={cn(
                        'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shrink-0',
                        key.status === 'active' ? TILE.active : key.status === 'paused' ? TILE.paused : TILE.ended,
                    )}>
                        {key.status === 'paused' ? <PauseCircle className="w-5 h-5" aria-hidden /> : <KeySquare className="w-5 h-5" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1 basis-[12rem]">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <button
                                type="button"
                                onClick={onOpen}
                                className="min-w-0 max-w-full text-left text-[15px] font-semibold text-ink hover:text-indigo-600 dark:hover:text-indigo-400 truncate focus-visible:outline-none focus-visible:underline"
                            >
                                {key.name}
                            </button>
                            <KeyStatusBadge apiKey={key} short />
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 min-w-0 text-xs text-ink-muted">
                            <code className="font-mono shrink-0">{key.prefix}…</code>
                            <CopyButton value={key.prefix} label="Copy the key’s prefix" className="p-0.5" />
                            {key.description && (
                                <>
                                    <span aria-hidden className="shrink-0">·</span>
                                    <span className="truncate">{key.description}</span>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="w-full sm:w-auto flex items-center gap-1.5 shrink-0">
                        {confirming ? (
                            <>
                                <span className="text-xs font-medium text-ink-secondary mr-1">Stop it now?</span>
                                <Button variant="danger" size="sm" onClick={() => { setConfirming(false); onRevoke?.() }}>
                                    Revoke
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <>
                                {key.status === 'paused' && resume?.url && (
                                    <a
                                        href={resume.url}
                                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-white bg-accent-lineage shadow-sm shadow-accent-lineage/25 hover:brightness-110 transition whitespace-nowrap"
                                    >
                                        <LogIn className="w-3.5 h-3.5" aria-hidden />
                                        Sign in to resume
                                    </a>
                                )}
                                {onRotate && (
                                    <Button variant="secondary" size="sm" leftIcon={RotateCw} onClick={onRotate} className={EDGE_BUTTON}>
                                        Rotate
                                    </Button>
                                )}
                                {onEdit && (
                                    <Button variant="ghost" size="sm" leftIcon={Pencil} onClick={onEdit}>
                                        Edit
                                    </Button>
                                )}
                                {onRevoke && (
                                    <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => setConfirming(true)}
                                        className="hover:text-rose-600 dark:hover:text-rose-400">
                                        Revoke
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                </div>

                <div className="mt-3.5">
                    <KeyChips apiKey={key} />
                </div>

                <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-px rounded-xl overflow-hidden border border-black/[0.06] dark:border-white/[0.07] bg-black/[0.06] dark:bg-white/[0.07]">
                    <Fact label="Expires">
                        <ExpiryFact expiresAt={key.expiresAt} />
                    </Fact>
                    <Fact label="Last used">
                        <span className={cn('block text-sm font-semibold truncate', key.lastUsedAt ? 'text-ink' : 'text-ink-muted')}>
                            {lastUsed.when}
                        </span>
                        <span className="block mt-0.5 text-[11px] text-ink-muted truncate">
                            {lastUsed.where ?? (key.lastUsedAt ? 'Address not recorded' : 'Nothing has called it yet')}
                        </span>
                    </Fact>
                    <Fact label="Last 14 days">
                        <span className="flex items-center justify-between gap-3">
                            <span className="min-w-0">
                                <span className="block text-sm font-semibold text-ink tabular-nums">
                                    {fortnight.toLocaleString()} request{fortnight === 1 ? '' : 's'}
                                </span>
                                <span className="block mt-0.5 text-[11px] text-ink-muted tabular-nums">
                                    {daily[daily.length - 1]?.toLocaleString() ?? 0} today
                                </span>
                            </span>
                            {busiest > 0 && (
                                <HoverTip
                                    label={`${fortnight.toLocaleString()} requests in 14 days`}
                                    detail={`Busiest day: ${busiest.toLocaleString()}. Today so far: ${(daily[daily.length - 1] ?? 0).toLocaleString()}.`}
                                    className="shrink-0"
                                >
                                    <Sparkline points={daily} width={96} height={28} tone={key.status === 'active' ? 'indigo' : 'slate'} />
                                </HoverTip>
                            )}
                        </span>
                    </Fact>
                </dl>

                {key.status === 'paused' && (
                    <p className="mt-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <PauseCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                        {key.kind === 'service'
                            ? 'Paused while nobody manages its service account — nothing was revoked. Calls made with it are refused until an administrator appoints a manager.'
                            : <>
                                Paused until you sign in through {resume?.provider ?? 'your identity provider'} again — nothing
                                was revoked. Calls made with it are refused until then.
                            </>}
                    </p>
                )}
            </div>
        </li>
    )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="bg-canvas-elevated px-3.5 py-3 min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1">{label}</dt>
            <dd className="min-w-0">{children}</dd>
        </div>
    )
}

/** A key that has ended, in one line — or, still being called, with what to do. */
export function PastKeyRow({ apiKey: key, onOpen, onRenew }: {
    apiKey: ApiKey
    onOpen: () => void
    onRenew?: () => void
}) {
    const calls = stillCalled(key)
    const when = key.revokedAt
        ? `${describeRevocation(key, 'owner')} · ${formatDay(key.revokedAt)}`
        : expiryCountdown(key.expiresAt).label
    return (
        <li className={cn(
            'rounded-xl border px-3.5 py-3',
            calls > 0
                ? 'border-amber-500/30 bg-amber-500/[0.05]'
                : 'border-black/[0.06] dark:border-white/[0.07] bg-black/[0.015] dark:bg-white/[0.02]',
        )}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button
                    type="button"
                    onClick={onOpen}
                    className="min-w-0 max-w-full truncate text-left text-sm font-semibold text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:underline"
                >
                    {key.name}
                </button>
                <code className="text-[11px] font-mono text-ink-muted">{key.prefix}…</code>
                <KeyStatusBadge apiKey={key} short />
                <span className="text-xs text-ink-muted">{when}</span>
                <span className="ml-auto flex items-center gap-1.5">
                    {onRenew && (
                        <Button variant={calls > 0 ? 'primary' : 'secondary'} size="sm" leftIcon={RotateCw} onClick={onRenew} className={calls > 0 ? undefined : EDGE_BUTTON}>
                            Renew
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" rightIcon={ChevronRight} onClick={onOpen} aria-label={`Details of “${key.name}”`}>
                        Details
                    </Button>
                </span>
            </div>
            {key.revokedNote && (
                <p className="mt-2 flex items-start gap-2 text-xs text-ink-secondary">
                    <Ban className="w-3.5 h-3.5 mt-px shrink-0 text-ink-muted" aria-hidden />
                    <span>“{key.revokedNote}”</span>
                </p>
            )}
            {calls > 0 && (
                <p className="mt-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    Still being called — {calls.toLocaleString()} request{calls === 1 ? '' : 's'} in the last 7 days
                    were refused. Renew it to give whatever calls it a working key.
                </p>
            )}
        </li>
    )
}
