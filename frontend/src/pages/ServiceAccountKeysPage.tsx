/**
 * ServiceAccountKeysPage — a service account's keys, for one of its managers.
 *
 * The keys act as the account, never as you: they reach what the account's
 * own roles give it, count against its own limit, and keep working when you
 * leave, as long as someone still manages it. You make, rotate and revoke
 * them here, confirming it's you exactly as for your own.
 *
 * Above them, what keeps them working: whether the account is enabled, who
 * manages it and whether they can act now, and where it has a role. While
 * nobody manages it, its keys work until the grace period ends and then
 * pause — the page says which, and until when. Who manages it, and its
 * roles, are an administrator's to change.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
    AlertCircle, ArrowLeft, Bot, Code2, History, KeySquare, Plus, RefreshCw, ShieldAlert, Users,
} from 'lucide-react'

import { AccountCard, AccountShell } from '@/components/account/AccountShell'
import { Banner } from '@/components/apiKeys/Banner'
import { DrawerActions } from '@/components/apiKeys/DrawerActions'
import { EditKeyDialog } from '@/components/apiKeys/EditKeyDialog'
import { KeyCard, PastKeyRow } from '@/components/apiKeys/KeyCard'
import { KeyDetailDrawer } from '@/components/apiKeys/KeyDetailDrawer'
import { RotateKeyDialog } from '@/components/apiKeys/RotateKeyDialog'
import { clearDraft, peekDraft, type ApiKeyDraft } from '@/components/apiKeys/apiKeyDraft'
import { isLive, isRenewable, stepUpUnavailable } from '@/components/apiKeys/apiKeyFormat'
import { KeyClientProvider, useKeyClient } from '@/components/apiKeys/keyClient'
import { ApiKeyWizard } from '@/components/apiKeys/wizard/ApiKeyWizard'
import { ManagerRow, StandingChip, standingOf } from '@/components/serviceAccounts/parts'
import { Button, IconButton } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { serviceAccountKeys, type ApiKey, type ApiKeyOptions, type KeyRef } from '@/services/apiKeyService'
import { serviceAccountService, type ServiceAccountDetail } from '@/services/serviceAccountService'
import { useFeature } from '@/store/features'

export function ServiceAccountKeysPage() {
    const { accountId = '' } = useParams()
    const [account, setAccount] = useState<ServiceAccountDetail | null>(null)
    const [error, setError] = useState<string | null>(null)
    useDocumentTitle(account ? `${account.name} · API keys` : 'Service account')

    useEffect(() => {
        let live = true
        serviceAccountService.mineGet(accountId)
            .then((found) => { if (live) { setAccount(found); setError(null) } })
            .catch((err: unknown) => {
                if (live) setError(err instanceof Error ? err.message : 'This service account could not be loaded.')
            })
        return () => { live = false }
    }, [accountId])

    const client = useMemo(() => serviceAccountKeys(accountId), [accountId])
    const name = account?.name ?? null
    const keyAccount = useMemo(() => (name === null ? null : { id: accountId, name }), [accountId, name])

    return (
        <AccountShell
            title={account?.name ?? 'Service account'}
            blurb="Keys that let an integration act as this service account — not as you."
        >
            <a href="/me/api-keys" className="inline-flex items-center gap-1.5 w-fit text-xs font-medium text-ink-secondary hover:text-ink">
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> API keys
            </a>
            {error && (
                <Banner tone="danger" icon={AlertCircle} title="This service account could not be opened">
                    {error} It may not exist, or you may not manage it.
                </Banner>
            )}
            {account && keyAccount && (
                <KeyClientProvider client={client} account={keyAccount}>
                    <AboutAccount account={account} />
                    <AccountKeys account={account} />
                </KeyClientProvider>
            )}
            {!account && !error && (
                <div className="space-y-3" aria-busy="true">
                    {[0, 1].map((i) => (
                        <div key={i} className="h-40 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] animate-pulse motion-reduce:animate-none" />
                    ))}
                </div>
            )}
        </AccountShell>
    )
}

/** What keeps its keys working: its standing, who manages it, where it has a role. */
function AboutAccount({ account }: { account: ServiceAccountDetail }) {
    const standing = standingOf(account)
    return (
        <AccountCard
            icon={Bot}
            title="About this service account"
            blurb={account.description ?? 'An integration acts as this account through the keys below.'}
        >
            <div className="flex flex-wrap items-center gap-2">
                <StandingChip account={account} />
                <span className="text-xs text-ink-muted">{standing.detail}</span>
            </div>

            <h3 className="mt-5 mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Managed by</h3>
            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]" aria-label="Managers">
                {account.managers.map((m) => <ManagerRow key={`${m.type}:${m.id}`} manager={m} />)}
            </ul>
            {account.managers.some((m) => m.type === 'group') && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-muted">
                    <Users className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    Everyone in a managing team can make keys that act as this account.
                </p>
            )}

            <h3 className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Where it has a role</h3>
            {account.roles.length === 0 ? (
                <p className="text-xs text-ink-muted">
                    No roles yet: its keys reach nothing until an administrator gives it one.
                </p>
            ) : (
                <ul className="flex flex-wrap gap-2" aria-label="Roles">
                    {account.roles.map((r) => (
                        <li key={r.bindingId} className="px-2.5 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-xs text-ink-secondary">
                            <span className="font-semibold text-ink">{r.workspaceName ?? r.workspaceId}</span> · {r.role}
                        </li>
                    ))}
                </ul>
            )}
            <p className="mt-4 text-xs text-ink-muted">
                Who manages it, and where it has a role, are changed by an administrator.
            </p>
        </AccountCard>
    )
}

function AccountKeys({ account }: { account: ServiceAccountDetail }) {
    const client = useKeyClient()
    const { notify } = useAppNotifications()
    const keysEnabled = useFeature('apiKeysEnabled')
    const [keys, setKeys] = useState<ApiKey[] | null>(null)
    const [options, setOptions] = useState<ApiKeyOptions | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [olderHistory, setOlderHistory] = useState(false)
    const [version, setVersion] = useState(0)
    const reload = useCallback(() => setVersion((v) => v + 1), [])

    // Back from confirming with an identity provider: what was chosen for
    // this account before leaving, read once and cleared at once.
    const [parked] = useState(() => peekDraft(Date.now(), account.id))
    useEffect(() => { if (parked) clearDraft() }, [parked])
    const [wizard, setWizard] = useState<{ seq: number; resumed: ApiKeyDraft | null } | null>(
        () => (parked?.mode === 'create' ? { seq: 0, resumed: parked } : null),
    )
    const [rotating, setRotating] = useState<{ keyId: string; resumed: ApiKeyDraft | null } | null>(
        () => (parked && parked.mode !== 'create' && parked.keyId ? { keyId: parked.keyId, resumed: parked } : null),
    )
    const [editing, setEditing] = useState<ApiKey | null>(null)
    const [drawerKey, setDrawerKey] = useState<ApiKey | null>(null)
    const closeDrawer = useCallback(() => setDrawerKey(null), [])

    useEffect(() => {
        let live = true
        Promise.all([client.list(olderHistory ? 'all' : undefined), client.options()])
            .then(([list, opts]) => {
                if (!live) return
                setKeys(list)
                setOptions(opts)
                setError(null)
            })
            .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'Its keys could not be loaded.') })
        return () => { live = false }
    }, [client, version, olderHistory])

    const liveKeys = keys?.filter(isLive) ?? []
    const past = keys?.filter((k) => !isLive(k)) ?? []
    // As for your own keys, and the account must be enabled: a disabled one
    // gets no new key, though its keys can always be revoked.
    const mintable = keysEnabled && (options?.policy.enabled ?? false) && (options?.stepUpAvailable ?? false)
        && account.status === 'active'
    const max = options?.policy.maxActiveKeys ?? Infinity
    const canCreate = mintable && liveKeys.length < max
    const rotateKey = rotating ? keys?.find((k) => k.id === rotating.keyId) : undefined
    const openRotate = (key: ApiKey) => setRotating({ keyId: key.id, resumed: null })
    const openWizard = () => setWizard({ seq: Date.now(), resumed: null })

    async function revoke(key: ApiKey) {
        try {
            await client.revoke(key.id)
            notify('success', `“${key.name}” revoked — it stopped working just now`)
            if (drawerKey?.id === key.id) setDrawerKey(null)
            reload()
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    const openKey = useCallback((ref: KeyRef) => {
        const known = keys?.find((k) => k.id === ref.id)
        if (known) setDrawerKey(known)
        else client.get(ref.id).then(setDrawerKey).catch(() => notify('error', 'That key could not be loaded.'))
    }, [keys, notify, client])

    return (
        <>
            {error && <Banner tone="danger" icon={AlertCircle} title="Its keys could not be loaded">{error}</Banner>}
            {options && !options.policy.enabled && (
                <Banner tone="warn" icon={AlertCircle} title="API keys are switched off">
                    API keys are turned off for this deployment: none of them work, and new ones cannot be
                    made. You can still revoke these.
                </Banner>
            )}
            {options?.policy.enabled && !options.stepUpAvailable && (
                <Banner tone="warn" icon={ShieldAlert} title={stepUpUnavailable(options.stepUpReason).title}>
                    {stepUpUnavailable(options.stepUpReason).body}
                </Banner>
            )}
            {account.status !== 'active' && (
                <Banner tone="warn" icon={ShieldAlert} title="This service account is disabled">
                    Its keys don’t work, and none can be made or rotated, until an administrator enables it.
                    You can still revoke them.
                </Banner>
            )}

            <AccountCard
                icon={KeySquare}
                title="Its keys"
                blurb="Send one as a bearer token in the Authorization header. It acts as the account, never as you."
            >
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <code className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-[11px] font-mono text-ink-secondary">
                        <Code2 className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                        Authorization: Bearer nxsat_…
                    </code>
                    <div className="flex items-center gap-2 ml-auto">
                        <IconButton icon={RefreshCw} label="Refresh" detail="Read its keys again" onClick={reload} />
                        <HoverTip
                            label={canCreate ? 'Make a key for an integration to act as this account' : 'No key can be made right now'}
                            detail={!canCreate && mintable ? `It has ${liveKeys.length} of the ${options?.policy.maxActiveKeys} keys allowed. Revoke one first.` : undefined}
                        >
                            <Button variant="primary" size="sm" leftIcon={Plus} disabled={!canCreate} onClick={openWizard}>
                                Create key
                            </Button>
                        </HoverTip>
                    </div>
                </div>

                {keys === null ? (
                    <div className="space-y-3" aria-busy="true">
                        {[0, 1].map((i) => (
                            <div key={i} className="h-40 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] animate-pulse motion-reduce:animate-none" />
                        ))}
                    </div>
                ) : liveKeys.length === 0 ? (
                    <div className="flex flex-col items-center text-center py-8 px-4">
                        <span className="w-11 h-11 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center mb-3">
                            <KeySquare className="w-5 h-5 text-ink-muted" aria-hidden />
                        </span>
                        <p className="text-sm font-semibold text-ink">No live keys</p>
                        <p className="mt-1 text-xs text-ink-muted max-w-sm">
                            Create one for the integration that runs as this account. Swapping a personal key for it
                            changes nothing else: the same header, routes and answers.
                        </p>
                    </div>
                ) : (
                    <ul className="space-y-3" aria-label="Live keys">
                        {liveKeys.map((key) => (
                            <KeyCard
                                key={key.id}
                                apiKey={key}
                                onOpen={() => setDrawerKey(key)}
                                onRotate={mintable ? () => openRotate(key) : undefined}
                                onEdit={() => setEditing(key)}
                                onRevoke={() => void revoke(key)}
                            />
                        ))}
                    </ul>
                )}
            </AccountCard>

            {past.length > 0 && (
                <AccountCard
                    icon={History}
                    title="Expired and revoked"
                    blurb={`${past.length} key${past.length === 1 ? '' : 's'} · ${olderHistory ? 'Every key that has ended.' : 'Kept here for 90 days after they end.'} None of these work any more.`}
                >
                    <ul className="space-y-2">
                        {past.map((key) => (
                            <PastKeyRow
                                key={key.id}
                                apiKey={key}
                                onOpen={() => setDrawerKey(key)}
                                onRenew={mintable && isRenewable(key) ? () => openRotate(key) : undefined}
                            />
                        ))}
                    </ul>
                </AccountCard>
            )}
            {keys !== null && !olderHistory && (
                <div className="px-1">
                    <Button variant="ghost" size="sm" leftIcon={History} onClick={() => setOlderHistory(true)}>
                        Show older history
                    </Button>
                </div>
            )}

            {wizard && options && (
                <ApiKeyWizard
                    key={wizard.seq}
                    options={options}
                    resumed={wizard.resumed}
                    onClose={() => setWizard(null)}
                    onCreated={reload}
                />
            )}
            {rotateKey && options && (
                <RotateKeyDialog
                    apiKey={rotateKey}
                    options={options}
                    resumed={rotating?.resumed}
                    onClose={() => setRotating(null)}
                    onDone={reload}
                />
            )}
            {editing && (
                <EditKeyDialog
                    apiKey={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(saved) => {
                        setKeys((ks) => ks?.map((k) => (k.id === saved.id ? saved : k)) ?? ks)
                        setDrawerKey((d) => (d?.id === saved.id ? saved : d))
                        setEditing(null)
                        notify('success', `“${saved.name}” saved`)
                    }}
                />
            )}
            <KeyDetailDrawer
                apiKey={drawerKey}
                variant="owner"
                load={client.get}
                layered={editing !== null || rotateKey !== undefined}
                onClose={closeDrawer}
                onOpenKey={openKey}
                actions={drawerKey && (
                    <DrawerActions
                        key={drawerKey.id}
                        apiKey={drawerKey}
                        resumeUrl={null}
                        onRotate={mintable && (isLive(drawerKey) || isRenewable(drawerKey)) ? () => openRotate(drawerKey) : undefined}
                        onEdit={drawerKey.status !== 'revoked' ? () => setEditing(drawerKey) : undefined}
                        onRevoke={isLive(drawerKey) ? () => void revoke(drawerKey) : undefined}
                    />
                )}
            />
        </>
    )
}
