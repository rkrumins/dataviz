/**
 * MyApiKeysPage — keys that let scripts and services act as you.
 *
 * Each key does what you could do yourself, limited further to what you chose
 * when you made it: some workspaces, views or data sources, and read or write.
 * The page answers the questions a person has about a key they may have
 * forgotten: what it can reach, when it was last used and from where, when it
 * stops working — and lets them end it at once.
 *
 * Revoking is always available, even with API keys switched off for the
 * deployment: closing a credential must never depend on being allowed to
 * open one.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    AlertCircle, ChevronDown, Clock, KeySquare, Plus, RefreshCw, RotateCw, Trash2,
} from 'lucide-react'

import { AccountCard, AccountShell, EmptyState } from '@/components/account/AccountShell'
import { ApiKeyDialog } from '@/components/apiKeys/ApiKeyDialog'
import { takeDraft, type ApiKeyDraft } from '@/components/apiKeys/apiKeyDraft'
import {
    STATUS_LABEL, describePermissions, describeResources, isLive,
} from '@/components/apiKeys/apiKeyFormat'
import { Button } from '@/components/ui/Button'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import {
    apiKeyService,
    type ApiKey,
    type ApiKeyDetail,
    type ApiKeyOptions,
} from '@/services/apiKeyService'
import { useFeature } from '@/store/features'

export function MyApiKeysPage() {
    useDocumentTitle('API keys')
    return (
        <AccountShell
            title="API keys"
            blurb="Keys that let scripts and services act as you, limited to what you choose."
        >
            <ApiKeysContent />
        </AccountShell>
    )
}

function ApiKeysContent() {
    const { notify } = useAppNotifications()
    const keysEnabled = useFeature('apiKeysEnabled')
    const [keys, setKeys] = useState<ApiKey[] | null>(null)
    const [options, setOptions] = useState<ApiKeyOptions | null>(null)
    const [error, setError] = useState<string | null>(null)
    // A fresh dialog per opening (``seq`` is its key), so its form starts
    // from what it is opened with.
    const [dialog, setDialog] = useState<{ seq: number; rotating?: ApiKey; draft?: ApiKeyDraft | null } | null>(null)
    const open = (with_: { rotating?: ApiKey; draft?: ApiKeyDraft | null }) =>
        setDialog({ seq: Date.now(), ...with_ })
    const [expanded, setExpanded] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const [list, opts] = await Promise.all([apiKeyService.list(), apiKeyService.options()])
            setKeys(list)
            setOptions(opts)
            setError(null)
            return { list, opts }
        } catch (err) {
            setError((err as Error).message)
            return null
        }
    }, [])

    // Coming back from confirming with an identity provider: reopen the
    // form with what was filled in before leaving.
    useEffect(() => {
        void load().then((loaded) => {
            const draft = takeDraft()
            if (!draft || !loaded) return
            const rotating = draft.mode === 'rotate'
                ? loaded.list.find((k) => k.id === draft.keyId)
                : undefined
            if (draft.mode === 'rotate' && !rotating) return
            open({ rotating, draft })
        })
    }, [load])

    const live = keys?.filter(isLive) ?? []
    const past = keys?.filter((k) => !isLive(k)) ?? []
    // Minting needs keys switched on, by the flag the shell reads and by the
    // server's own answer; a rotation replaces a key, so it does not count
    // against the limit.
    const mintable = keysEnabled && (options?.policy.enabled ?? false)
    const canCreate = mintable && live.length < (options?.policy.maxActiveKeys ?? Infinity)

    async function revoke(key: ApiKey) {
        try {
            await apiKeyService.revoke(key.id)
            notify('success', `“${key.name}” revoked — it stopped working just now`)
            await load()
        } catch (err) {
            notify('error', (err as Error).message)
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
            {options && !options.policy.enabled && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                        API keys are turned off for this deployment: none of them work, and new ones
                        cannot be made. You can still revoke yours.
                    </span>
                </div>
            )}

            <AccountCard
                icon={KeySquare}
                title="Your keys"
                blurb="Send one as `Authorization: Bearer <key>`. It acts as you, never more."
            >
                <div className="flex items-center justify-between gap-3 mb-4">
                    <p className="text-xs text-ink-muted">
                        {options
                            ? `${live.length} of ${options.policy.maxActiveKeys} in use.`
                            : 'Loading…'}
                        {options?.policy.ssoSignInWindowDays
                            ? ` If you sign in through an identity provider, your keys pause after ${options.policy.ssoSignInWindowDays} days without a sign-in, and resume when you next sign in.`
                            : ''}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        <Button variant="ghost" size="sm" leftIcon={RefreshCw} onClick={() => void load()}>
                            Refresh
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            leftIcon={Plus}
                            disabled={!canCreate}
                            onClick={() => open({})}
                        >
                            Create key
                        </Button>
                    </div>
                </div>

                {keys === null ? null : live.length === 0 ? (
                    <EmptyState icon={KeySquare}>
                        No keys yet. Create one for a script or service that needs to read or
                        change views and data as you.
                    </EmptyState>
                ) : (
                    <ul className="space-y-2">
                        {live.map((key) => (
                            <KeyRow
                                key={key.id}
                                apiKey={key}
                                expanded={expanded === key.id}
                                onToggle={() => setExpanded(expanded === key.id ? null : key.id)}
                                onRotate={mintable ? () => open({ rotating: key }) : undefined}
                                onRevoke={() => revoke(key)}
                            />
                        ))}
                    </ul>
                )}
            </AccountCard>

            {past.length > 0 && (
                <AccountCard
                    icon={Clock}
                    title="Expired and revoked"
                    blurb="Kept as a record. None of these work any more."
                >
                    <ul className="space-y-2">
                        {past.map((key) => (
                            <KeyRow
                                key={key.id}
                                apiKey={key}
                                expanded={expanded === key.id}
                                onToggle={() => setExpanded(expanded === key.id ? null : key.id)}
                            />
                        ))}
                    </ul>
                </AccountCard>
            )}

            <p className="text-xs text-ink-muted px-1">
                Signing out everywhere or changing your password does not stop your keys. If one may
                have leaked, revoke it here.
            </p>

            <ApiKeyDialog
                key={dialog?.seq ?? 0}
                open={dialog !== null}
                options={options}
                rotating={dialog?.rotating}
                draft={dialog?.draft ?? null}
                onClose={() => setDialog(null)}
                onChanged={() => void load()}
            />
        </>
    )
}

function KeyRow({
    apiKey: key, expanded, onToggle, onRotate, onRevoke,
}: {
    apiKey: ApiKey
    expanded: boolean
    onToggle: () => void
    onRotate?: () => void
    onRevoke?: () => void
}) {
    const [confirming, setConfirming] = useState(false)
    const [detail, setDetail] = useState<ApiKeyDetail | null>(null)

    useEffect(() => {
        if (!expanded || detail) return
        apiKeyService.get(key.id).then(setDetail).catch(() => setDetail(null))
    }, [expanded, detail, key.id])

    const tone = key.status === 'active'
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
        : key.status === 'paused'
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
            : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border'

    return (
        <li className="rounded-xl border border-glass-border bg-canvas p-3.5">
            <div className="flex items-start gap-3">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} what “${key.name}” can do`}
                    className="mt-0.5 text-ink-muted hover:text-ink"
                >
                    <ChevronDown className={cn('w-4 h-4 transition-transform', !expanded && '-rotate-90')} />
                </button>
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink truncate">{key.name}</span>
                        <code className="text-[11px] font-mono text-ink-muted">{key.prefix}…</code>
                        <span className={cn('px-1.5 py-0.5 rounded-md text-[10px] font-semibold border', tone)}>
                            {STATUS_LABEL[key.status] ?? key.status}
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-secondary">
                        {describePermissions(key.permissions)} on {describeResources(key.resources).toLowerCase()}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
                        <TimeStamp at={key.createdAt} prefix="Created" colorByAge={false} icon={null} />
                        {key.lastUsedAt
                            ? <TimeStamp at={key.lastUsedAt} prefix="Last used" icon={null}
                                tooltipLines={[key.lastUsedIp && `From ${key.lastUsedIp}`, key.lastUsedUserAgent]} />
                            : <span>Never used</span>}
                        <span>
                            {key.revokedAt
                                ? `Revoked ${new Date(key.revokedAt).toLocaleDateString()}`
                                : key.expiresAt
                                    ? `${key.status === 'expired' ? 'Expired' : 'Expires'} ${new Date(key.expiresAt).toLocaleDateString()}`
                                    : 'Never expires'}
                        </span>
                        {key.allowedCidrs.length > 0 && <span>Only from {key.allowedCidrs.join(', ')}</span>}
                    </div>
                </div>
                {(onRotate || onRevoke) && (
                    <div className="flex items-center gap-1.5 shrink-0">
                        {confirming ? (
                            <>
                                <span className="text-xs text-ink-muted">Stop it now?</span>
                                <Button variant="danger" size="sm" onClick={() => { setConfirming(false); onRevoke?.() }}>
                                    Revoke
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <>
                                {onRotate && (
                                    <Button variant="secondary" size="sm" leftIcon={RotateCw} onClick={onRotate}>
                                        Rotate
                                    </Button>
                                )}
                                {onRevoke && (
                                    <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => setConfirming(true)}>
                                        Revoke
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
            {expanded && <Access detail={detail} />}
        </li>
    )
}

const LEVEL_WORD = { none: 'none', read: 'read', write: 'read & write' } as const

function Access({ detail }: { detail: ApiKeyDetail | null }) {
    if (!detail) return <p className="mt-3 ml-7 text-xs text-ink-muted">Loading…</p>
    const { workspaces, views, dataSources } = detail.effectiveAccess
    return (
        <div className="mt-3 ml-7 space-y-3 text-xs">
            <p className="text-ink-muted">
                What it can do right now — your access today, narrowed by the key. It changes as yours does.
            </p>
            {workspaces.length === 0 ? (
                <p className="text-amber-600 dark:text-amber-400">
                    Nothing at the moment: you no longer have access to what it was limited to.
                </p>
            ) : (
                <table className="w-full">
                    <thead>
                        <tr className="text-left text-ink-muted">
                            <th className="font-medium py-1">Workspace</th>
                            <th className="font-medium py-1">Views</th>
                            <th className="font-medium py-1">Data</th>
                        </tr>
                    </thead>
                    <tbody>
                        {workspaces.map((w) => (
                            <tr key={w.id} className="text-ink-secondary">
                                <td className="py-1 pr-2">{w.name}</td>
                                <td className="py-1 pr-2">{LEVEL_WORD[w.views]}{w.publish ? ', publish' : ''}</td>
                                <td className="py-1">{LEVEL_WORD[w.data]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {[...views.map((v) => ({ ...v, kind: 'View' })), ...dataSources.map((d) => ({ ...d, kind: 'Data source' }))].map((r) => (
                <p key={r.id} className="text-ink-secondary">
                    {r.kind} “{r.name ?? r.id}”: {r.level === 'none' ? 'out of reach' : LEVEL_WORD[r.level]}
                </p>
            ))}
        </div>
    )
}
