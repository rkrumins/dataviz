/**
 * AdminServiceAccounts — principals that never sign in, for integrations to
 * run as, and who answers for each.
 *
 * Super and org admins (`system:service-accounts:manage`) create them,
 * naming their managers — people, or teams, whose members come and go with
 * the identity provider — and hand a leaver's accounts to a successor. Each
 * account opens on its own page, where its managers and the administrators
 * look after it, give it roles, and make its keys.
 *
 * Every row says how its account stands, most pressing first: no manager left
 * and when its keys pause, or a single person it depends on. The grace period
 * is the deployment's (`serviceAccountUnmanagedGrace`), as the server reports
 * it with the list.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    AlertCircle, ArrowRightLeft, Bot, Plus, RefreshCw, Search, ShieldCheck, Users, X,
} from 'lucide-react'

import { KeyDialog } from '@/components/apiKeys/KeyDialog'
import { PageContainer } from '@/components/layout/PageContainer'
import { HandOverPanel, holdsSeats, useManagedBy } from '@/components/serviceAccounts/HandOver'
import { SubjectPicker, subjectKey, type Subject } from '@/components/serviceAccounts/SubjectPicker'
import { StandingChip, TeamNote } from '@/components/serviceAccounts/parts'
import { Button, IconButton } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { TablePagination } from '@/components/ui/TablePagination'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { serviceAccountHref } from '@/lib/serviceAccounts'
import { cn } from '@/lib/utils'
import {
    serviceAccountService,
    type ServiceAccount,
    type ServiceAccountDetail,
    type ServiceAccountList,
} from '@/services/serviceAccountService'

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
                                <a
                                    href={serviceAccountHref(a.id)}
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
                                </a>
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
                    onCreated={(created) => window.location.assign(serviceAccountHref(created.id))}
                />
            )}
            {handingOver && <HandOverDialog onClose={() => setHandingOver(false)} onDone={() => { setHandingOver(false); reload() }} />}
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
    const { accounts, total, error } = useManagedBy(person?.id ?? null)
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
                        disabled={!person || !successor || !accounts || !holdsSeats(accounts, total)}
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
                        <p className="text-sm text-ink-muted">{person.name} manages no service account, and made no key that still works.</p>
                    ) : (
                        <HandOverPanel person={person} accounts={accounts} total={total} successor={successor} onSuccessor={setSuccessor} />
                    )}
                </div>
            )}
        </KeyDialog>
    )
}
