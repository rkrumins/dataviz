/**
 * ServiceAccountPage — one service account: how it stands, who manages it,
 * where it has a role, and its keys.
 *
 * Its managers run it here: they rename it, disable and enable it, appoint and
 * remove its managers, take away roles it no longer needs, and make its keys.
 * The administrators of service accounts can do all of that and give it
 * roles — and, reading every workspace themselves, let it read every
 * workspace; someone who may make any account's keys sees it for those. What
 * each may do is the server's `can`, and the page offers nothing more.
 *
 * The keys act as the account, never as you: they reach what the account's
 * own roles give it, count against its own limit, and keep working when you
 * leave, as long as someone still manages it. While nobody manages it, its
 * keys work until the grace period ends and then pause — the page says which,
 * and until when.
 *
 * Deleting it stops its keys at once. For 30 days the page shows it deleted,
 * as it was, for whoever may to restore it; then it is purged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
    AlertCircle, ArrowLeft, Bot, Clock, Code2, ExternalLink, Globe, History, KeySquare, Plus, Power, RefreshCw,
    RotateCcw, Send, ShieldAlert, Trash2, Users, X,
} from 'lucide-react'

import { AccountCard, AccountShell } from '@/components/account/AccountShell'
import { Banner } from '@/components/apiKeys/Banner'
import { DrawerActions } from '@/components/apiKeys/DrawerActions'
import { EditKeyDialog } from '@/components/apiKeys/EditKeyDialog'
import { KeyCard, PastKeyRow } from '@/components/apiKeys/KeyCard'
import { KeyDetailDrawer } from '@/components/apiKeys/KeyDetailDrawer'
import { RotateKeyDialog } from '@/components/apiKeys/RotateKeyDialog'
import { clearDraft, peekDraft, type ApiKeyDraft } from '@/components/apiKeys/apiKeyDraft'
import { formatDay, isLive, isRenewable, stepUpUnavailable } from '@/components/apiKeys/apiKeyFormat'
import { KeyDialog } from '@/components/apiKeys/KeyDialog'
import { KeyClientProvider, useKeyClient } from '@/components/apiKeys/keyClient'
import { ApiKeyWizard } from '@/components/apiKeys/wizard/ApiKeyWizard'
import { RequestForAccount } from '@/components/serviceAccounts/RequestForAccount'
import { RoleGrant } from '@/components/serviceAccounts/RoleGrant'
import { SubjectPicker, subjectKey } from '@/components/serviceAccounts/SubjectPicker'
import { ManagerRow, StandingChip, TeamNote, standingOf } from '@/components/serviceAccounts/parts'
import { Button, IconButton } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { roleVisualFor } from '@/lib/roleVisual'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { accessRequestsService } from '@/services/accessRequestsService'
import { serviceAccountKeys, type ApiKey, type ApiKeyOptions, type KeyRef } from '@/services/apiKeyService'
import {
    serviceAccountService, type ServiceAccountDetail, type ServiceAccountManager,
} from '@/services/serviceAccountService'
import { usePermission } from '@/store/auth'
import { useFeature } from '@/store/features'

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

export function ServiceAccountPage() {
    const { accountId = '' } = useParams()
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const central = usePermission('system:service-accounts:manage')
    const [account, setAccount] = useState<ServiceAccountDetail | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    useDocumentTitle(account ? account.name : 'Service account')

    const load = useCallback(() => serviceAccountService.get(accountId), [accountId])
    useEffect(() => {
        let live = true
        load()
            .then((found) => { if (live) { setAccount(found); setError(null) } })
            .catch((err: unknown) => {
                if (live) setError(message(err, 'This service account could not be loaded.'))
            })
        return () => { live = false }
    }, [load])

    /** Run a change; the account as it now stands comes back with most of them. */
    const change = useCallback(async (fn: () => Promise<unknown>, done: string) => {
        setBusy(true)
        try {
            const after = await fn()
            const now = after && typeof after === 'object' && 'can' in after ? after as ServiceAccountDetail : await load()
            notify('success', done)
            if (!now.can.view) {
                // They stepped down: it is no longer theirs to see.
                navigate('/me/api-keys')
                return true
            }
            setAccount(now)
            return true
        } catch (err) {
            notify('error', message(err, 'That change could not be made.'))
            return false
        } finally {
            setBusy(false)
        }
    }, [load, navigate, notify])

    const client = useMemo(() => serviceAccountKeys(accountId), [accountId])
    const name = account?.name ?? null
    const keyAccount = useMemo(() => (name === null ? null : { id: accountId, name }), [accountId, name])

    return (
        <AccountShell
            title={account?.name ?? 'Service account'}
            blurb="An account an integration runs as — with keys that act as it, not as you."
        >
            <a
                href={central ? '/admin/service-accounts' : '/me/api-keys'}
                className="inline-flex items-center gap-1.5 w-fit text-xs font-medium text-ink-secondary hover:text-ink"
            >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> {central ? 'Service accounts' : 'API keys'}
            </a>
            {error && (
                <Banner tone="danger" icon={AlertCircle} title="This service account could not be opened">
                    {error} It may not exist, or you may not manage it.
                </Banner>
            )}
            {account && keyAccount && (
                <>
                    {account.deletedAt && <Deleted account={account} busy={busy} change={change} />}
                    <AboutAccount account={account} central={central} busy={busy} change={change} reload={() => void load().then(setAccount)} />
                    {account.can.keys ? (
                        <KeyClientProvider client={client} account={keyAccount}>
                            <AccountKeys account={account} />
                        </KeyClientProvider>
                    ) : (
                        <KeysSummary account={account} />
                    )}
                </>
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

type Change = (fn: () => Promise<unknown>, done: string) => Promise<boolean>

/** A deleted account, as it was, until it is purged — and the way back. */
function Deleted({ account, busy, change }: { account: ServiceAccountDetail; busy: boolean; change: Change }) {
    return (
        <Banner
            tone="warn"
            icon={Trash2}
            title={`Deleted ${account.deletedAt ? formatDay(account.deletedAt) : ''} — its keys don’t work`}
            action={account.can.restore && (
                <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={RotateCcw}
                    disabled={busy}
                    onClick={() => void change(() => serviceAccountService.restore(account.id), `“${account.name}” restored`)}
                >
                    Restore
                </Button>
            )}
        >
            {account.adminHold ? 'An administrator' : 'Its managers'} can restore it
            {account.purgesAt && <> until {formatDay(account.purgesAt)}</>}, with its keys, roles and managers as
            they were. After that its keys are revoked, and its roles and managers removed.
        </Banner>
    )
}

/** Deleting an account, said before it is done: what stops, and the way back. */
function DeleteDialog({ account, held, busy, onClose, onDelete }: {
    account: ServiceAccountDetail
    /** Only an administrator will be able to restore it. */
    held: boolean
    busy: boolean
    onClose: () => void
    onDelete: () => void
}) {
    const keys = account.liveKeys
    // When it would be purged, deleted now: worked out once, as the dialog opens.
    const [purges] = useState(() => formatDay(new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()))
    return (
        <KeyDialog
            icon={Trash2}
            tone="danger"
            title={`Delete “${account.name}”?`}
            subtitle="For an integration nothing runs any more."
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button variant="danger" size="sm" leftIcon={Trash2} loading={busy} onClick={onDelete}>Delete</Button>
                </>
            )}
        >
            <ul className="space-y-2 text-sm text-ink-secondary list-disc pl-5">
                <li>
                    {keys === 0 ? 'It has no live keys.' : `Its ${keys} live key${keys === 1 ? '' : 's'} stop${keys === 1 ? 's' : ''} working at once.`}
                </li>
                {account.requests.length > 0 && <li>Its requests waiting on a workspace are withdrawn.</li>}
                <li>
                    {held ? 'Only an administrator can restore it' : 'Its managers can restore it'} until {purges},
                    with its keys, roles and managers as they were.
                </li>
                <li>After that its keys are revoked, and its roles and managers removed.</li>
            </ul>
        </KeyDialog>
    )
}

/** Letting it read every workspace, said before it is done: what it reaches,
 *  and what it doesn't. */
function OrgReadDialog({ account, busy, onClose, onGive }: {
    account: ServiceAccountDetail
    busy: boolean
    onClose: () => void
    onGive: () => void
}) {
    return (
        <KeyDialog
            icon={Globe}
            title="Let it read every workspace?"
            subtitle={`“${account.name}”, for an integration that reads across the whole organization.`}
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" size="sm" leftIcon={Globe} loading={busy} onClick={onGive}>Let it read them all</Button>
                </>
            )}
        >
            <ul className="space-y-2 text-sm text-ink-secondary list-disc pl-5">
                <li>
                    Its keys can read the views, data sources, semantic layers, catalog and providers of every
                    workspace, those created later too, as far as each key reaches.
                </li>
                <li>It can change nothing more than before, and the audit log, role bindings and analytics stay out of its reach.</li>
                <li>Whoever manages it can read every workspace through it, so its managers can appoint only someone who already reads every workspace.</li>
                <li>Its managers can take it away.</li>
            </ul>
        </KeyDialog>
    )
}

/** What keeps its keys working — its standing, who manages it, where it has a
 *  role — and, for whoever may, the means to change each. */
function AboutAccount({ account, central, busy, change, reload }: {
    account: ServiceAccountDetail
    /** An administrator of service accounts: may leave it with no manager. */
    central: boolean
    busy: boolean
    change: Change
    /** Read the account again — after asking a workspace for its access. */
    reload: () => void
}) {
    const [asking, setAsking] = useState(false)
    const keeping = new Set(account.requests.map((r) => r.bindingId).filter(Boolean))
    const { can } = account
    const standing = standingOf(account)
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [removingLast, setRemovingLast] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [givingOrgRead, setGivingOrgRead] = useState(false)
    const last = account.managers.length === 1
    const teams = account.managers.filter((m) => m.type === 'group').map((m) => m.name)

    const removeManager = (m: ServiceAccountManager) => {
        if (last && !removingLast) { setRemovingLast(true); return }
        setRemovingLast(false)
        void change(() => serviceAccountService.removeManager(account.id, m), `${m.name} no longer manages it`)
    }

    return (
        <AccountCard
            icon={Bot}
            title="About this service account"
            blurb={account.description ?? 'An integration acts as this account through its keys.'}
        >
            <div className="flex flex-wrap items-center gap-2">
                <StandingChip account={account} />
                {!account.deletedAt && <span className="text-xs text-ink-muted">{standing.detail}</span>}
            </div>
            {editing ? (
                <div className="mt-3 space-y-2">
                    <input
                        aria-label="Name"
                        value={name}
                        maxLength={80}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full h-9 px-3 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500"
                    />
                    <textarea
                        aria-label="What it is for"
                        value={description}
                        maxLength={500}
                        rows={2}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500 resize-none"
                    />
                    <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={busy || !name.trim()}
                            onClick={() => void change(
                                () => serviceAccountService.update(account.id, { name: name.trim(), description: description.trim() || null }),
                                'Saved',
                            ).then((ok) => { if (ok) setEditing(false) })}
                        >
                            Save
                        </Button>
                    </div>
                </div>
            ) : (can.edit || can.disable || can.enable || can.delete) && (
                <div className="mt-2 -ml-2 flex flex-wrap items-center gap-1">
                    {can.edit && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setName(account.name); setDescription(account.description ?? ''); setEditing(true) }}
                        >
                            Rename or describe
                        </Button>
                    )}
                    {account.status === 'active' && can.disable && (
                        <HoverTip label="Stop every key it holds, at once" detail="Nothing is revoked: enabling it brings them back.">
                            <Button
                                variant="ghost"
                                size="sm"
                                leftIcon={Power}
                                disabled={busy}
                                className="hover:text-rose-600 dark:hover:text-rose-400"
                                onClick={() => void change(() => serviceAccountService.disable(account.id), `“${account.name}” disabled — its keys stopped working`)}
                            >
                                Disable
                            </Button>
                        </HoverTip>
                    )}
                    {account.status !== 'active' && can.enable && (
                        <Button
                            variant="secondary"
                            size="sm"
                            leftIcon={Power}
                            disabled={busy}
                            onClick={() => void change(() => serviceAccountService.enable(account.id), `“${account.name}” enabled`)}
                        >
                            Enable
                        </Button>
                    )}
                    {can.delete && (
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={Trash2}
                            disabled={busy}
                            className="hover:text-rose-600 dark:hover:text-rose-400"
                            onClick={() => setDeleting(true)}
                        >
                            Delete…
                        </Button>
                    )}
                </div>
            )}
            {deleting && (
                <DeleteDialog
                    account={account}
                    held={central || account.adminHold}
                    busy={busy}
                    onClose={() => setDeleting(false)}
                    onDelete={() => void change(
                        () => serviceAccountService.delete(account.id),
                        `“${account.name}” deleted — its keys stopped working`,
                    ).then(() => setDeleting(false))}
                />
            )}

            <h3 className="mt-5 mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Managed by</h3>
            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]" aria-label="Managers">
                {account.managers.map((m) => (
                    <ManagerRow
                        key={`${m.type}:${m.id}`}
                        manager={m}
                        action={can.managers && (last && !central ? (
                            <HoverTip label="Its last manager" detail="Appoint another first: nobody would answer for it, and its keys would pause.">
                                <IconButton icon={Trash2} variant="danger" label={`Stop ${m.name} managing it`} disabled />
                            </HoverTip>
                        ) : (
                            <IconButton
                                icon={Trash2}
                                variant="danger"
                                label={removingLast ? `Remove ${m.name}, the last manager?` : `Stop ${m.name} managing it`}
                                detail={removingLast ? 'Nobody would manage it: its keys keep working for the grace period, then pause.' : undefined}
                                disabled={busy}
                                onClick={() => removeManager(m)}
                            />
                        ))}
                    />
                ))}
            </ul>
            {removingLast && (
                <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    That is its last manager: removing them leaves nobody answering for it, and its keys pause
                    after the grace period. Press remove again to go ahead.
                </p>
            )}
            {teams.length > 0 && (can.managers ? <TeamNote teams={teams} account={`“${account.name}”`} /> : (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-muted">
                    <Users className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    Everyone in a managing team can make keys that act as this account.
                </p>
            ))}
            {can.managers && (
                <div className="mt-3">
                    <SubjectPicker
                        label="Add a manager"
                        exclude={account.managers.map(subjectKey)}
                        onPick={(s) => void change(() => serviceAccountService.addManager(account.id, s), `${s.name} now manages it`)}
                    />
                    <p className="mt-1.5 text-xs text-ink-muted">
                        A manager can do whatever it can, so you can appoint someone only if they already reach
                        what it reaches, or you could give them that yourself.
                    </p>
                </div>
            )}

            <h3 className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Where it has a role</h3>
            {account.orgRead && (
                <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] text-xs text-ink-secondary">
                    <Globe className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                        <span className="font-semibold text-ink">Reads every workspace</span>, those created later too, as
                        far as each key reaches. It changes nothing there.
                    </span>
                    {can.revoke && (
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            aria-label="Take away read access to every workspace"
                            onClick={() => void change(
                                () => serviceAccountService.revokeOrgRead(account.id),
                                'It no longer reads every workspace',
                            )}
                        >
                            Take away
                        </Button>
                    )}
                </div>
            )}
            {account.roles.length === 0 ? (
                !account.orgRead && (
                    <p className="text-xs text-ink-muted mb-3">
                        No roles yet: its keys reach nothing until a workspace gives it one.
                    </p>
                )
            ) : (
                <ul className="flex flex-wrap gap-2 mb-3" aria-label="Roles">
                    {account.roles.map((r) => (
                        <li key={r.bindingId} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-xs text-ink-secondary">
                            <span>
                                <span className="font-semibold text-ink">{r.workspaceName ?? r.workspaceId}</span> · {roleVisualFor(r.role).label}
                                {r.expiresAt && <> · until {new Date(r.expiresAt).toLocaleDateString()}</>}
                            </span>
                            {r.expiresAt && can.request && (keeping.has(r.bindingId) ? (
                                <span className="px-1.5 text-ink-muted">Asked to keep</span>
                            ) : (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void change(
                                        () => accessRequestsService.extend({ bindingId: r.bindingId }),
                                        `Asked ${r.workspaceName ?? 'the workspace'} to keep its access`,
                                    )}
                                >
                                    Keep
                                </Button>
                            ))}
                            {can.revoke && (
                                <IconButton
                                    icon={X}
                                    label={`Take away its role in ${r.workspaceName ?? r.workspaceId}`}
                                    disabled={busy}
                                    onClick={() => void change(() => serviceAccountService.revokeRole(account.id, r.bindingId), 'Role taken away')}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {account.requests.length > 0 && (
                <ul className="space-y-1.5 mb-3" aria-label="Waiting on a workspace">
                    {account.requests.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                            <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-hidden />
                            <span className="min-w-0 flex-1">
                                {r.bindingId ? 'Asked to keep' : 'Asked for'} <span className="font-semibold text-ink">{roleVisualFor(r.role).label}</span>
                                {' in '}<span className="font-semibold text-ink">{r.workspaceName ?? r.workspaceId}</span>
                                {r.requestedBy && <> by {r.requestedBy}</>} — waiting on the workspace
                            </span>
                            {can.request && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void change(() => accessRequestsService.withdraw(r.id), 'Request withdrawn')}
                                >
                                    Withdraw
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {can.grant && (
                <RoleGrant busy={busy} onGrant={(workspaceId, role) => change(() => serviceAccountService.grantRole(account.id, { workspaceId, role }), 'Role given')} />
            )}
            {can.orgRead && !account.orgRead && (
                <Button variant="ghost" size="sm" leftIcon={Globe} className="mt-3" onClick={() => setGivingOrgRead(true)}>
                    Let it read every workspace…
                </Button>
            )}
            {givingOrgRead && (
                <OrgReadDialog
                    account={account}
                    busy={busy}
                    onClose={() => setGivingOrgRead(false)}
                    onGive={() => void change(
                        () => serviceAccountService.grantOrgRead(account.id),
                        `“${account.name}” now reads every workspace`,
                    ).then(() => setGivingOrgRead(false))}
                />
            )}
            {can.request && (
                <Button variant="secondary" size="sm" leftIcon={Send} className="mt-3" onClick={() => setAsking(true)}>
                    Ask a workspace for access
                </Button>
            )}
            {asking && (
                <RequestForAccount
                    account={account}
                    onClose={() => setAsking(false)}
                    onSent={() => { setAsking(false); reload() }}
                />
            )}
        </AccountCard>
    )
}

/** For someone who may see the account but not make its keys. */
function KeysSummary({ account }: { account: ServiceAccountDetail }) {
    const canSeeKeys = usePermission('system:audit:read')
    return (
        <AccountCard icon={KeySquare} title="Its keys" blurb="Made by its managers. They act as the account, never as whoever made them.">
            <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 text-sm text-ink">
                    {account.liveKeys} live key{account.liveKeys === 1 ? '' : 's'}
                    {account.deletedAt && account.liveKeys > 0 ? ', stopped while it is deleted.' : '.'}
                </span>
                {canSeeKeys && (
                    <a href={`/admin/api-keys?ownerId=${encodeURIComponent(account.id)}`} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                        See them <ExternalLink className="w-3 h-3" aria-hidden />
                    </a>
                )}
            </div>
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
                    Its keys don’t work, and none can be made or rotated, until
                    {account.adminHold ? ' an administrator enables it' : ' it is enabled'}. You can still revoke them.
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
