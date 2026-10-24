/**
 * AdminServiceAccounts — principals that never sign in, for integrations to
 * run as, and who answers for each.
 *
 * Super and org admins (`system:service-accounts:manage`) create them, appoint
 * their managers — people, or teams, whose members come and go with the
 * identity provider — give them workspace roles, and hand a leaver's accounts
 * to a successor. The account's keys are made by its managers (and by holders
 * of `system:users:manage`) on its own page, never here.
 *
 * Every row says how its account stands, most pressing first: no manager left
 * and when its keys pause, or a single person it depends on. The grace period
 * is the deployment's (`serviceAccountUnmanagedGrace`), as the server reports
 * it with the list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    AlertCircle, ArrowRightLeft, Bot, ExternalLink, KeySquare, Plus, Power, RefreshCw, Search, ShieldCheck,
    Trash2, Users, X,
} from 'lucide-react'

import { KeyDialog } from '@/components/apiKeys/KeyDialog'
import { PageContainer } from '@/components/layout/PageContainer'
import { HandOverPanel, useManagedBy } from '@/components/serviceAccounts/HandOver'
import { SubjectPicker, subjectKey, type Subject } from '@/components/serviceAccounts/SubjectPicker'
import { ManagerRow, StandingChip, standingOf } from '@/components/serviceAccounts/parts'
import { Button, IconButton } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { TablePagination } from '@/components/ui/TablePagination'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { roleVisualFor } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'
import { accessRequestsService, type RequestableRole } from '@/services/accessRequestsService'
import {
    serviceAccountService,
    type ServiceAccount,
    type ServiceAccountDetail,
    type ServiceAccountList,
    type ServiceAccountManager,
} from '@/services/serviceAccountService'
import { workspaceService } from '@/services/workspaceService'
import { usePermission } from '@/store/auth'

const PAGE_SIZE = 25

type Tab = 'all' | 'active' | 'disabled'

const TABS: { value: Tab; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'disabled', label: 'Disabled' },
]

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

export function AdminServiceAccounts() {
    const [tab, setTab] = useState<Tab>('all')
    const [q, setQ] = useState('')
    const search = useDebouncedValue(q.trim(), 250)
    const [page, setPage] = useState(0)
    const [version, setVersion] = useState(0)
    const reload = useCallback(() => setVersion((v) => v + 1), [])
    const [list, setList] = useState<ServiceAccountList | null>(null)
    const [answered, setAnswered] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const [handingOver, setHandingOver] = useState(false)
    // ``?account=<id>`` opens one account: the link its notices, its activity
    // and the chips that name it carry. Read once at mount from
    // ``window.location``, as the users and groups pages read theirs.
    const [openId, setOpenId] = useState<string | null>(() => {
        try {
            return new URLSearchParams(window.location.search).get('account')
        } catch {
            return null
        }
    })

    const request = JSON.stringify([search, tab, page, version])
    const loading = answered !== request
    useEffect(() => {
        let live = true
        serviceAccountService.list({
            q: search || undefined, status: tab === 'all' ? undefined : tab,
            limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        })
            .then((res) => { if (live) { setList(res); setError(null); setAnswered(request) } })
            .catch((err: unknown) => {
                if (live) { setError(message(err, 'The service accounts could not be loaded.')); setAnswered(request) }
            })
        return () => { live = false }
    }, [search, tab, page, request])

    const items = list?.items ?? []
    const total = list?.total ?? 0
    const grace = list?.graceDays ?? null

    return (
        <PageContainer gutter="shell" className="py-8 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20 shrink-0">
                        <Bot className="w-6 h-6 text-white" aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-ink">Service accounts</h1>
                        <p className="text-sm text-ink-muted">
                            Accounts integrations run as — who answers for each, and where it has a role.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <IconButton icon={RefreshCw} label="Refresh" detail="Read the service accounts again" onClick={reload} />
                    <Button variant="secondary" size="sm" leftIcon={ArrowRightLeft} onClick={() => setHandingOver(true)} className="border-black/[0.10] dark:border-white/[0.12] shadow-sm">
                        Hand over…
                    </Button>
                    <Button variant="primary" size="sm" leftIcon={Plus} onClick={() => setCreating(true)}>
                        Create service account
                    </Button>
                </div>
            </div>

            {grace !== null && (
                <p className="flex items-start gap-2 text-xs text-ink-muted max-w-3xl">
                    <ShieldCheck className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    <span>
                        {grace > 0
                            ? `An account's keys keep working for ${grace} days after its last manager goes, so its integration keeps running while you appoint a successor.`
                            : 'An account’s keys pause as soon as its last manager goes, until you appoint a successor.'}
                        {' '}Teams as managers, and handing over when someone leaves, keep it from coming to that.
                    </span>
                </p>
            )}

            {error && (
                <div role="alert" className="flex items-start gap-2 p-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-canvas-elevated overflow-hidden shadow-sm">
                <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 border-b border-black/[0.07] dark:border-white/[0.08]">
                    <div className="relative flex-1 min-w-[12rem] max-w-sm">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                        <input
                            aria-label="Search service accounts"
                            value={q}
                            onChange={(e) => { setQ(e.target.value); setPage(0) }}
                            placeholder="Name or description"
                            className="w-full h-9 pl-9 pr-3 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                        />
                    </div>
                    <div role="tablist" aria-label="Status" className="flex gap-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.05]">
                        {TABS.map((t) => (
                            <button
                                key={t.value}
                                type="button"
                                role="tab"
                                aria-selected={tab === t.value}
                                onClick={() => { setTab(t.value); setPage(0) }}
                                className={cn(
                                    'px-3 py-1 rounded-lg text-xs font-semibold transition-colors duration-150',
                                    tab === t.value ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                {items.length === 0 && !loading ? (
                    <EmptyState
                        icon={Bot}
                        title={search || tab !== 'all' ? 'No service accounts match' : 'No service accounts yet'}
                        description={search || tab !== 'all'
                            ? 'Nothing fits these filters.'
                            : 'Create one for each integration that should keep running whoever set it up — and give it a team as its manager.'}
                        action={search || tab !== 'all'
                            ? { label: 'Clear filters', onClick: () => { setQ(''); setTab('all'); setPage(0) } }
                            : { label: 'Create service account', onClick: () => setCreating(true) }}
                    />
                ) : items.length === 0 ? (
                    <div className="p-4 space-y-3" aria-busy="true">
                        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
                    </div>
                ) : (
                    <ul aria-label="Service accounts" className={cn('divide-y divide-black/[0.06] dark:divide-white/[0.07] transition-opacity', loading && 'opacity-60')}>
                        {items.map((a) => (
                            <li key={a.id}>
                                <button
                                    type="button"
                                    onClick={() => setOpenId(a.id)}
                                    className="w-full flex flex-wrap sm:flex-nowrap items-center gap-3 px-4 py-3.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                >
                                    <span className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                                        <Bot className="w-4 h-4" aria-hidden />
                                    </span>
                                    <span className="min-w-0 flex-1 basis-[12rem]">
                                        <span className="block text-sm font-semibold text-ink truncate">{a.name}</span>
                                        <span className="block text-xs text-ink-muted truncate">{managerSummary(a)}</span>
                                    </span>
                                    <StandingChip account={a} />
                                    <span className="hidden lg:block w-28 text-xs text-ink-muted"><DateTime at={a.createdAt} prefix="Created " /></span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {total > PAGE_SIZE && (
                    <div className="flex items-center justify-end px-4 py-3 border-t border-black/[0.07] dark:border-white/[0.08]">
                        <TablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
                    </div>
                )}
            </div>

            {creating && (
                <CreateDialog
                    onClose={() => setCreating(false)}
                    onCreated={(created) => { setCreating(false); reload(); setOpenId(created.id) }}
                />
            )}
            {handingOver && <HandOverDialog onClose={() => setHandingOver(false)} onDone={() => { setHandingOver(false); reload() }} />}
            {openId && <AccountDialog key={openId} accountId={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
        </PageContainer>
    )
}

/** "Ada Lovelace and Data platform", "Ada, Bea and 2 more". */
function managerSummary(a: ServiceAccount): string {
    const names = a.managers.map((m) => m.name)
    if (names.length === 0) return 'No managers'
    const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
    return `Managed by ${shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`}`
}

/** "Anyone in Data platform can make keys that act as Metadata sync." */
function TeamNote({ teams, account }: { teams: string[]; account: string }) {
    if (teams.length === 0) return null
    return (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
            <Users className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
            Anyone in {teams.join(' or ')} can make keys that act as {account}.
        </p>
    )
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (account: ServiceAccountDetail) => void }) {
    const { notify } = useAppNotifications()
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [managers, setManagers] = useState<Subject[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const ready = name.trim() !== '' && managers.length > 0

    async function create() {
        setBusy(true)
        setError(null)
        try {
            const created = await serviceAccountService.create({
                name: name.trim(),
                description: description.trim() || undefined,
                managers: managers.map(({ type, id }) => ({ type, id })),
            })
            notify('success', `“${created.name}” created`)
            onCreated(created)
        } catch (err) {
            setError(message(err, 'The service account could not be created.'))
            setBusy(false)
        }
    }

    return (
        <KeyDialog
            icon={Bot}
            title="Create a service account"
            subtitle="For one integration, so it keeps running whoever set it up."
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" size="sm" leftIcon={Plus} disabled={!ready} loading={busy} onClick={() => void create()}>
                        Create
                    </Button>
                </>
            )}
        >
            <div className="space-y-4">
                <div>
                    <label htmlFor="sa-name" className="block text-xs font-semibold text-ink-secondary mb-1.5">Name</label>
                    <input
                        id="sa-name"
                        value={name}
                        maxLength={80}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Metadata sync"
                        className="w-full h-9 px-3 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    />
                </div>
                <div>
                    <label htmlFor="sa-description" className="block text-xs font-semibold text-ink-secondary mb-1.5">What it is for</label>
                    <textarea
                        id="sa-description"
                        value={description}
                        maxLength={500}
                        rows={2}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Which integration runs as it, and where"
                        className="w-full px-3 py-2 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 resize-none"
                    />
                </div>
                <div>
                    <p className="text-xs font-semibold text-ink-secondary mb-1.5">Managers</p>
                    {managers.length > 0 && (
                        <ul aria-label="Chosen managers" className="flex flex-wrap gap-1.5 mb-2">
                            {managers.map((m) => (
                                <li key={subjectKey(m)} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg text-xs font-semibold bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
                                    {m.type === 'group' ? <Users className="w-3 h-3" aria-hidden /> : null}
                                    {m.name}
                                    <button
                                        type="button"
                                        onClick={() => setManagers((ms) => ms.filter((x) => subjectKey(x) !== subjectKey(m)))}
                                        aria-label={`Don’t make ${m.name} a manager`}
                                        className="p-0.5 rounded hover:bg-indigo-500/15"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <SubjectPicker
                        label="Add a person or a team"
                        exclude={managers.map(subjectKey)}
                        onPick={(s) => setManagers((ms) => [...ms, s])}
                    />
                    <TeamNote teams={managers.filter((m) => m.type === 'group').map((m) => m.name)} account={name.trim() ? `“${name.trim()}”` : 'it'} />
                    {managers.length === 0 && (
                        <p className="mt-2 text-xs text-ink-muted">
                            At least one. A team that comes from your identity provider keeps it managed as people join and leave.
                        </p>
                    )}
                </div>
                {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
        </KeyDialog>
    )
}

function HandOverDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const { notify } = useAppNotifications()
    const [person, setPerson] = useState<Subject | null>(null)
    const { accounts, error } = useManagedBy(person?.id ?? null)
    const [successor, setSuccessor] = useState<Subject | null>(null)
    const [busy, setBusy] = useState(false)

    async function handOver() {
        if (!person || !successor) return
        setBusy(true)
        try {
            const { handedOver } = await serviceAccountService.handOver({
                fromUserId: person.id, to: { type: successor.type, id: successor.id },
            })
            notify('success', `${handedOver.length} service account${handedOver.length === 1 ? '' : 's'} handed over to ${successor.name}`)
            onDone()
        } catch (err) {
            notify('error', message(err, 'The service accounts could not be handed over.'))
            setBusy(false)
        }
    }

    return (
        <KeyDialog
            icon={ArrowRightLeft}
            title="Hand over service accounts"
            subtitle="Before someone leaves: their seat on every account they manage goes to a successor."
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button
                        variant="primary"
                        size="sm"
                        leftIcon={ArrowRightLeft}
                        disabled={!person || !successor || !accounts?.length}
                        loading={busy}
                        onClick={() => void handOver()}
                    >
                        Hand over
                    </Button>
                </>
            )}
        >
            {!person ? (
                <SubjectPicker label="Whose service accounts?" types={['user']} onPick={(p) => { setPerson(p); setSuccessor(null) }} />
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center gap-2.5 p-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.04]">
                        <span className="min-w-0 flex-1 text-sm text-ink">
                            From <span className="font-semibold">{person.name}</span>
                        </span>
                        <button
                            type="button"
                            onClick={() => { setPerson(null); setSuccessor(null) }}
                            aria-label="Choose someone else"
                            className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    {error ? (
                        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
                    ) : accounts === null ? (
                        <Skeleton className="h-20 rounded-xl" />
                    ) : accounts.length === 0 ? (
                        <p className="text-sm text-ink-muted">{person.name} manages no service account themselves.</p>
                    ) : (
                        <HandOverPanel person={person} accounts={accounts} successor={successor} onSuccessor={setSuccessor} />
                    )}
                </div>
            )}
        </KeyDialog>
    )
}

/** One account: what it is, who manages it, where it has a role, its keys. */
function AccountDialog({ accountId, onClose, onChanged }: {
    accountId: string
    onClose: () => void
    /** Something changed: the list should be read again. */
    onChanged: () => void
}) {
    const { notify } = useAppNotifications()
    const canMintAny = usePermission('system:users:manage')
    const canSeeKeys = usePermission('system:audit:read')
    const [account, setAccount] = useState<ServiceAccountDetail | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [removingLast, setRemovingLast] = useState(false)

    const load = useCallback(() => {
        serviceAccountService.get(accountId).then(setAccount).catch((err: unknown) => setFailed(message(err, 'It could not be loaded.')))
    }, [accountId])
    useEffect(load, [load])

    /** Run a change; the account as it now stands comes back with most of them. */
    const change = async (fn: () => Promise<unknown>, done: string) => {
        setBusy(true)
        try {
            const after = await fn()
            if (after && typeof after === 'object' && 'managers' in after) setAccount(after as ServiceAccountDetail)
            else load()
            notify('success', done)
            onChanged()
            return true
        } catch (err) {
            notify('error', message(err, 'That change could not be made.'))
            return false
        } finally {
            setBusy(false)
        }
    }

    const removeManager = (m: ServiceAccountManager) => {
        if (account && account.managers.length === 1 && !removingLast) { setRemovingLast(true); return }
        setRemovingLast(false)
        void change(() => serviceAccountService.removeManager(accountId, m), `${m.name} no longer manages it`)
    }

    const teams = account?.managers.filter((m) => m.type === 'group').map((m) => m.name) ?? []

    return (
        <KeyDialog
            icon={Bot}
            wide
            title={account?.name ?? 'Service account'}
            subtitle={account?.description ?? undefined}
            onClose={onClose}
            footer={account ? (
                <>
                    {account.status === 'active' ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={Power}
                            disabled={busy}
                            className="mr-auto hover:text-rose-600 dark:hover:text-rose-400"
                            onClick={() => void change(() => serviceAccountService.disable(accountId), `“${account.name}” disabled — its keys stopped working`)}
                        >
                            Disable
                        </Button>
                    ) : (
                        <Button
                            variant="secondary"
                            size="sm"
                            leftIcon={Power}
                            disabled={busy}
                            className="mr-auto"
                            onClick={() => void change(() => serviceAccountService.enable(accountId), `“${account.name}” enabled`)}
                        >
                            Enable
                        </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
                </>
            ) : <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}
        >
            {failed ? (
                <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{failed}</p>
            ) : !account ? (
                <div className="space-y-3" aria-busy="true">
                    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
                </div>
            ) : (
                <div className="space-y-6">
                    <section aria-label="How it stands">
                        <div className="flex flex-wrap items-center gap-2">
                            <StandingChip account={account} />
                            <span className="text-xs text-ink-muted">{standingOf(account).detail}</span>
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
                                            () => serviceAccountService.update(accountId, { name: name.trim(), description: description.trim() || null }),
                                            'Saved',
                                        ).then((ok) => { if (ok) setEditing(false) })}
                                    >
                                        Save
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 -ml-2"
                                onClick={() => { setName(account.name); setDescription(account.description ?? ''); setEditing(true) }}
                            >
                                Rename or describe
                            </Button>
                        )}
                    </section>

                    <section aria-label="Managers">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Managed by</h3>
                        <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                            {account.managers.map((m) => (
                                <ManagerRow
                                    key={`${m.type}:${m.id}`}
                                    manager={m}
                                    action={(
                                        <IconButton
                                            icon={Trash2}
                                            variant="danger"
                                            label={removingLast ? `Remove ${m.name}, the last manager?` : `Stop ${m.name} managing it`}
                                            detail={removingLast ? 'Nobody would manage it: its keys keep working for the grace period, then pause.' : undefined}
                                            disabled={busy}
                                            onClick={() => removeManager(m)}
                                        />
                                    )}
                                />
                            ))}
                        </ul>
                        {removingLast && (
                            <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                That is its last manager: removing them leaves nobody answering for it, and its keys pause
                                after the grace period. Press remove again to go ahead.
                            </p>
                        )}
                        <TeamNote teams={teams} account={`“${account.name}”`} />
                        <div className="mt-3">
                            <SubjectPicker
                                label="Add a manager"
                                exclude={account.managers.map(subjectKey)}
                                onPick={(s) => void change(() => serviceAccountService.addManager(accountId, s), `${s.name} now manages it`)}
                            />
                        </div>
                    </section>

                    <section aria-label="Roles">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Where it has a role</h3>
                        {account.roles.length === 0 ? (
                            <p className="text-xs text-ink-muted mb-3">No roles yet: its keys reach nothing until you give it one.</p>
                        ) : (
                            <ul className="space-y-1.5 mb-3">
                                {account.roles.map((r) => (
                                    <li key={r.bindingId} className="flex items-center gap-2 text-sm">
                                        <span className="min-w-0 flex-1 truncate">
                                            <span className="font-semibold text-ink">{r.workspaceName ?? r.workspaceId}</span>
                                            <span className="text-ink-muted"> · {roleVisualFor(r.role).label}</span>
                                        </span>
                                        <IconButton
                                            icon={X}
                                            label={`Take away its role in ${r.workspaceName ?? r.workspaceId}`}
                                            disabled={busy}
                                            onClick={() => void change(() => serviceAccountService.revokeRole(accountId, r.bindingId), 'Role taken away')}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                        <RoleGrant busy={busy} onGrant={(workspaceId, role) => change(() => serviceAccountService.grantRole(accountId, { workspaceId, role }), 'Role given')} />
                    </section>

                    <section aria-label="Keys" className="flex flex-wrap items-center gap-3 p-3.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04]">
                        <KeySquare className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 text-sm text-ink">
                            {account.liveKeys} live key{account.liveKeys === 1 ? '' : 's'}, made by its managers.
                        </span>
                        {canSeeKeys && (
                            <a href={`/admin/api-keys?ownerId=${encodeURIComponent(account.id)}`} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                                See them <ExternalLink className="w-3 h-3" aria-hidden />
                            </a>
                        )}
                        {canMintAny && (
                            <a href={`/me/service-accounts/${encodeURIComponent(account.id)}`} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                                Make or revoke its keys <ExternalLink className="w-3 h-3" aria-hidden />
                            </a>
                        )}
                    </section>
                </div>
            )}
        </KeyDialog>
    )
}

/** A workspace, then a role in it that neither administers it nor lets people in. */
function RoleGrant({ busy, onGrant }: { busy: boolean; onGrant: (workspaceId: string, role: string) => Promise<boolean> }) {
    const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null)
    const [workspaceId, setWorkspaceId] = useState('')
    const [roles, setRoles] = useState<{ workspaceId: string; roles: RequestableRole[] } | null>(null)
    const [role, setRole] = useState('')

    useEffect(() => {
        let live = true
        workspaceService.list()
            .then((list) => { if (live) setWorkspaces(list.map((w) => ({ id: w.id, name: w.name }))) })
            .catch(() => { if (live) setWorkspaces([]) })
        return () => { live = false }
    }, [])
    useEffect(() => {
        if (!workspaceId) return
        let live = true
        accessRequestsService.requestableRoles(workspaceId)
            .then((options) => { if (live) setRoles({ workspaceId, roles: options.roles }) })
            .catch(() => { if (live) setRoles({ workspaceId, roles: [] }) })
        return () => { live = false }
    }, [workspaceId])

    const offered = useMemo(() => (roles?.workspaceId === workspaceId ? roles.roles : []), [roles, workspaceId])
    const select = 'h-9 px-2.5 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500'
    return (
        <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Workspace" value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setRole('') }} className={cn(select, 'min-w-[10rem] flex-1')}>
                <option value="">{workspaces === null ? 'Loading workspaces…' : 'Choose a workspace'}</option>
                {(workspaces ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} disabled={!workspaceId} className={cn(select, 'min-w-[9rem]')}>
                <option value="">Choose a role</option>
                {offered.map((r) => <option key={r.name} value={r.name}>{roleVisualFor(r.name).label}</option>)}
            </select>
            <Button
                variant="secondary"
                size="sm"
                leftIcon={Plus}
                disabled={busy || !workspaceId || !role}
                onClick={() => void onGrant(workspaceId, role).then((ok) => { if (ok) setRole('') })}
            >
                Give role
            </Button>
        </div>
    )
}
