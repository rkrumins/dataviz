/**
 * A person's profile — yours at /me/profile, anyone else's at /people/:userId: who they
 * are, the workspaces they run, the views they made and the data they look after, each
 * only as far as you can see it. Your own adds your conversations and what you watch.
 * Asking someone a question starts from here too: it's always about one of their views
 * or the data they look after.
 */
import { useMemo, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
    Building2, ChevronDown, Database, ExternalLink, Eye, LayoutGrid, Mail, MessageCircleQuestion, MessagesSquare, PencilLine,
    ShieldCheck, Sparkles, UserRound, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useAuthStore } from '@/store/auth'
import { PageContainer } from '@/components/layout/PageContainer'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { OverviewViewGrid } from '@/components/admin/workspace/overview/OverviewViewGrid'
import { listViews, type View } from '@/services/viewApiService'
import { peopleService, type PersonDataContact, type PersonProfile } from '@/services/peopleService'
import { personHref } from '@/components/ui/PersonChip'
import { workspaceColor } from '@/lib/workspaceColor'
import { useFeature } from '@/store/features'
import { useMySummary } from '@/features/discussions/useDiscussions'
import { useDiscussionsDrawer } from '@/features/discussions/drawerStore'
import { ConversationsTab, WaitingOnYouCard, WatchingTab } from '@/features/discussions/MyConversations'

const TABS = ['overview', 'views', 'data', 'conversations', 'watching'] as const
type Tab = (typeof TABS)[number]

const sourceLink = (c: PersonDataContact) =>
    `/workspaces/${encodeURIComponent(c.workspaceId)}?tab=data&section=sources&ds=${encodeURIComponent(c.dataSourceId)}`

export function PersonProfilePage() {
    const { userId } = useParams()
    const meId = useAuthStore(s => s.user?.id ?? null)
    const [params] = useSearchParams()
    // Your own id at /people/… is your profile.
    if (userId && userId === meId) return <Navigate to={`/me/profile${params.toString() ? `?${params}` : ''}`} replace />
    const id = userId ?? meId
    if (!id) return null
    return <Profile id={id} />
}

function Profile({ id }: { id: string }) {
    const navigate = useNavigate()
    const [params, setParams] = useSearchParams()
    const canAdmin = useAuthStore(s => s.can('system:admin'))
    const profile = useQuery({ queryKey: ['people', id], queryFn: () => peopleService.profile(id), staleTime: 60_000, retry: false })
    const views = useQuery({
        queryKey: ['people', id, 'views'],
        queryFn: () => listViews({ createdBy: id, sort: 'recently-modified', limit: 48 }),
        staleTime: 60_000,
    })
    const p = profile.data
    const conversations = useFeature('conversationsEnabled')
    // Your conversations and what you watch are yours alone: the tabs exist on your own profile.
    const mine = conversations && !!p?.isMe
    const unread = useMySummary().data?.totalUnread ?? 0
    useDocumentTitle(p ? (p.isMe ? 'Your profile' : p.person.displayName) : 'Profile')

    const rawTab = params.get('tab')
    const asked: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'overview'
    // Until the profile says whose it is, a link to ?tab=conversations waits on it rather than bouncing.
    const tab: Tab = (asked === 'conversations' || asked === 'watching') && p && !mine ? 'overview' : asked
    const setTab = (t: string) => setParams(prev => {
        const next = new URLSearchParams()
        // Leaving the conversations drops which box and thread were open.
        if (t !== 'overview') next.set('tab', t)
        if (t === 'conversations') for (const k of ['box', 'status', 'thread', 'message']) { const v = prev.get(k); if (v) next.set(k, v) }
        return next
    }, { replace: true })

    if (profile.isError) {
        return (
            <div className="absolute inset-0 overflow-y-auto bg-canvas">
                <PageContainer className="py-10">
                    <EmptyState icon={UserRound} title="We couldn’t find that person"
                        description="They may have left, or the link may be wrong."
                        action={{ label: 'Back', onClick: () => navigate(-1) }} />
                </PageContainer>
            </div>
        )
    }

    const viewList = views.data?.items ?? []
    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
        <PageContainer className="space-y-6 py-8 pb-24">
            {p ? <Header profile={p} views={viewList} viewCount={views.data?.total ?? null} canAdmin={canAdmin} /> : <HeaderSkeleton />}

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList look="underline" scrollable aria-label="Profile sections" className="gap-1 sm:gap-2">
                    <TabsTrigger value="overview" icon={Sparkles}>Overview</TabsTrigger>
                    <TabsTrigger value="views" icon={LayoutGrid} badge={<Count n={views.data?.total} />}>Views</TabsTrigger>
                    <TabsTrigger value="data" icon={Database} badge={<Count n={p?.dataContacts.length} />}>Data</TabsTrigger>
                    {mine && <TabsTrigger value="conversations" icon={MessagesSquare} badge={<Count n={unread} label="unread" accent />}>Conversations</TabsTrigger>}
                    {mine && <TabsTrigger value="watching" icon={Eye}>Watching</TabsTrigger>}
                </TabsList>

                <TabsContent value="overview" className="pt-5">
                    {p && <Overview profile={p} views={viewList} onTab={setTab}
                        waiting={mine ? <WaitingOnYouCard onOpen={id => setParams(id ? { tab: 'conversations', thread: id } : { tab: 'conversations' }, { replace: true })} /> : null} />}
                </TabsContent>
                <TabsContent value="views" className="pt-5">
                    <ViewsTab loading={views.isLoading} views={viewList} isMe={!!p?.isMe} name={p?.person.displayName ?? ''} />
                </TabsContent>
                <TabsContent value="data" className="pt-5">
                    {p && <DataTab profile={p} />}
                </TabsContent>
                {mine && (
                    <>
                        <TabsContent value="conversations" className="pt-5"><ConversationsTab /></TabsContent>
                        <TabsContent value="watching" className="pt-5"><WatchingTab /></TabsContent>
                    </>
                )}
            </Tabs>
        </PageContainer>
        </div>
    )
}

/** A tab's count: how many, or (accent) how many unread. Nothing for none. */
function Count({ n, label, accent = false }: { n: number | undefined; label?: string; accent?: boolean }) {
    if (!n) return null
    return (
        <span className={cn('min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums',
            accent ? 'bg-accent-lineage text-white' : 'bg-black/[0.05] text-ink-muted dark:bg-white/[0.08]')}>
            {n > 99 ? '99+' : n}{label && <span className="sr-only"> {label}</span>}
        </span>
    )
}

function Header({ profile: p, views, viewCount, canAdmin }: { profile: PersonProfile; views: View[]; viewCount: number | null; canAdmin: boolean }) {
    const person = p.person
    const facts = [
        viewCount != null && `${viewCount} view${viewCount === 1 ? '' : 's'}`,
        p.dataContacts.length > 0 && `looks after ${p.dataContacts.length} data source${p.dataContacts.length === 1 ? '' : 's'}`,
        p.workspacesTheyRun.length > 0 && `runs ${p.workspacesTheyRun.length} workspace${p.workspacesTheyRun.length === 1 ? '' : 's'}`,
    ].filter(Boolean) as string[]
    return (
        <section className="relative overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-violet-500/[0.14] via-fuchsia-500/[0.08] to-sky-500/[0.10]" />
            <div className="relative flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:p-8">
                <UserAvatar userId={person.id} name={person.displayName} avatarId={person.avatarId} hasImage={person.hasImage}
                    className={cn('h-20 w-20 shrink-0 text-2xl font-bold ring-4 ring-canvas-elevated shadow-lg', person.deleted && 'grayscale opacity-70')} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="truncate font-display text-2xl font-bold text-ink">{person.displayName}</h1>
                        {p.isMe && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">You</span>}
                        {person.deleted && <span className="rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2 py-0.5 text-[11px] font-semibold text-ink-muted">Former member</span>}
                    </div>
                    {person.email && !person.deleted && (
                        <a href={`mailto:${person.email}`} className="mt-1 inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink">
                            <Mail className="h-3.5 w-3.5" aria-hidden /> {person.email}
                        </a>
                    )}
                    {facts.length > 0 && <p className="mt-1 text-sm text-ink-muted">{facts.join(' · ')}</p>}
                    {p.workspacesTheyRun.length > 0 && (
                        <ul aria-label="Workspaces they run" className="mt-3 flex flex-wrap gap-1.5">
                            {p.workspacesTheyRun.slice(0, 5).map(w => (
                                <li key={w.id}>
                                    <Link to={`/workspaces/${encodeURIComponent(w.id)}`}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-violet-500/40">
                                        <span aria-hidden className={cn('h-2 w-2 rounded-full', workspaceColor(w.id).accent)} />
                                        <ShieldCheck className="h-3 w-3 text-ink-muted" aria-hidden /> {w.name}
                                    </Link>
                                </li>
                            ))}
                            {p.workspacesTheyRun.length > 5 && <li className="px-1 py-1 text-xs text-ink-muted">and {p.workspacesTheyRun.length - 5} more</li>}
                        </ul>
                    )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {!p.isMe && !person.deleted && <AskThem profile={p} views={views} />}
                    {p.isMe && (
                        <Link to="/me/account"
                            className="inline-flex h-9 items-center gap-2 rounded-xl border border-glass-border bg-canvas px-3.5 text-sm font-semibold text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                            <PencilLine className="h-4 w-4" aria-hidden /> Edit profile
                        </Link>
                    )}
                    {!p.isMe && canAdmin && (
                        <a href={personHref(person.id)}
                            className="inline-flex h-9 items-center gap-2 rounded-xl border border-glass-border bg-canvas px-3.5 text-sm font-semibold text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                            <ExternalLink className="h-4 w-4" aria-hidden /> Open in User Management
                        </a>
                    )}
                </div>
            </div>
        </section>
    )
}

function HeaderSkeleton() {
    return (
        <div aria-busy="true" className="flex items-end gap-5 rounded-3xl border border-glass-border bg-canvas-elevated p-8">
            <div className="h-20 w-20 animate-pulse rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="flex-1 space-y-2">
                <div className="h-6 w-56 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" />
                <div className="h-4 w-40 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.06]" />
            </div>
        </div>
    )
}

function Card({ title, icon: Icon, action, children }: { title: string; icon: typeof Users; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-ink"><Icon className="h-4 w-4 text-violet-500" aria-hidden /> {title}</h2>
                {action}
            </div>
            {children}
        </section>
    )
}

function Overview({ profile: p, views, onTab, waiting }: { profile: PersonProfile; views: View[]; onTab: (t: Tab) => void; waiting: ReactNode }) {
    const recent = views.slice(0, 6)
    const wsId = recent[0]?.workspaceId ?? ''
    return (
        <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
                <Card title={p.isMe ? 'Your latest views' : 'Their latest views'} icon={LayoutGrid}
                    action={views.length > 6 ? <button type="button" onClick={() => onTab('views')} className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">All views</button> : undefined}>
                    {recent.length === 0 ? (
                        <p className="text-sm text-ink-muted">{p.isMe ? 'You haven’t made a view yet.' : 'No views you can see.'}</p>
                    ) : (
                        <OverviewViewGrid wsId={wsId} views={recent} layout="compact" />
                    )}
                </Card>
            </div>
            <div className="space-y-5">
                {waiting}
                <Card title={p.isMe ? 'Data you look after' : 'Data they look after'} icon={Database}
                    action={p.dataContacts.length > 4 ? <button type="button" onClick={() => onTab('data')} className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">All</button> : undefined}>
                    {p.dataContacts.length === 0 ? (
                        <p className="text-sm text-ink-muted">Not named as a contact for any data you can see.</p>
                    ) : (
                        <ul className="space-y-2">{p.dataContacts.slice(0, 4).map(c => <DataRow key={c.dataSourceId} contact={c} />)}</ul>
                    )}
                </Card>
            </div>
        </div>
    )
}

function DataRow({ contact: c }: { contact: PersonDataContact }) {
    return (
        <li>
            <Link to={sourceLink(c)} className="flex items-center gap-3 rounded-xl border border-glass-border px-3 py-2.5 hover:border-violet-500/40 hover:bg-violet-500/[0.03]">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                    <Database className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{c.dataSourceName}</span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-ink-muted"><Building2 className="h-3 w-3" aria-hidden /> {c.workspaceName}</span>
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    c.role === 'owner' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-violet-500/10 text-violet-700 dark:text-violet-300')}>
                    {c.role === 'owner' ? 'Owner' : 'Steward'}{c.via === 'group' ? ' · via a team' : ''}
                </span>
            </Link>
        </li>
    )
}

function ViewsTab({ loading, views, isMe, name }: { loading: boolean; views: View[]; isMe: boolean; name: string }) {
    const wsId = useMemo(() => views[0]?.workspaceId ?? '', [views])
    if (loading) {
        return <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-48 animate-pulse rounded-2xl bg-black/[0.04] dark:bg-white/[0.05]" />)}</div>
    }
    if (views.length === 0) {
        return <EmptyState icon={LayoutGrid} title={isMe ? 'No views yet' : `No views of ${name}’s you can see`}
            description={isMe ? 'Views you make show up here, for others to find and ask you about.' : 'Views they share with you, or with everyone, show up here.'} />
    }
    return <OverviewViewGrid wsId={wsId} views={views} layout="cards" />
}

function DataTab({ profile: p }: { profile: PersonProfile }) {
    if (p.dataContacts.length === 0) {
        return <EmptyState icon={Database} title="No data to show"
            description={p.isMe ? 'When you’re named as a data source’s Owner or Steward, it shows up here — and questions about it reach you.' : 'They aren’t named as a contact for any data you can see.'} />
    }
    return <ul className="grid gap-2 md:grid-cols-2">{p.dataContacts.map(c => <DataRow key={c.dataSourceId} contact={c} />)}</ul>
}

/**
 * Asking someone a question is always about something of theirs: one of their views, or data
 * they look after. The menu lists those you can see; choosing one opens the questions drawer
 * with them among the people asked.
 */
function AskThem({ profile: p, views }: { profile: PersonProfile; views: View[] }) {
    const on = useFeature('conversationsEnabled')
    const open = useDiscussionsDrawer(s => s.open)
    if (!on || (views.length === 0 && p.dataContacts.length === 0)) return null
    const ask = (subject: { type: 'view' | 'data_source'; id: string; name: string }) =>
        open({ subject, compose: true, recipients: [p.person.id] })
    const item = 'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink outline-none data-[highlighted]:bg-black/[0.05] dark:data-[highlighted]:bg-white/[0.07]'
    return (
        <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
                <button type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3.5 text-sm font-semibold text-white shadow-sm hover:brightness-110">
                    <MessageCircleQuestion className="h-4 w-4" aria-hidden /> Ask a question <ChevronDown className="h-3.5 w-3.5 opacity-80" aria-hidden />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6}
                    className="z-[9999] max-h-80 w-72 overflow-y-auto rounded-xl border border-glass-border bg-canvas p-1 shadow-xl">
                    <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-ink-muted">What is it about?</p>
                    {views.length > 0 && <DropdownMenu.Label className="px-2.5 pt-1.5 text-[10.5px] font-bold uppercase tracking-wider text-ink-muted">Their views</DropdownMenu.Label>}
                    {views.slice(0, 8).map(v => (
                        <DropdownMenu.Item key={v.id} className={item} onSelect={() => ask({ type: 'view', id: v.id, name: v.name })}>
                            <LayoutGrid className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden /><span className="truncate">{v.name}</span>
                        </DropdownMenu.Item>
                    ))}
                    {p.dataContacts.length > 0 && <DropdownMenu.Label className="px-2.5 pt-2 text-[10.5px] font-bold uppercase tracking-wider text-ink-muted">Data they look after</DropdownMenu.Label>}
                    {p.dataContacts.slice(0, 8).map(c => (
                        <DropdownMenu.Item key={c.dataSourceId} className={item} onSelect={() => ask({ type: 'data_source', id: c.dataSourceId, name: c.dataSourceName })}>
                            <Database className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{c.dataSourceName}</span>
                            <span className="shrink-0 text-[11px] text-ink-muted">{c.workspaceName}</span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}
