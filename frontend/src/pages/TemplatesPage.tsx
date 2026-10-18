/**
 * Templates — the library of layer layouts people start Context Views from.
 *
 * Built-ins ship with the product; the organization's are curated by template
 * managers; workspaces and people keep their own, and share them with teams.
 * Every card offers exactly what the server says its reader may do.
 *
 * `/templates/:templateId` opens one in the drawer; `?new=1` opens the studio;
 * `?tab=requests` lists, for template managers, the requests to offer a team's
 * template to everyone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
    Heart, Inbox, LayoutTemplate as TemplateIcon, Package, Plus, Search, Sparkles, Trash2, Users, X,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { PageContainer } from '@/components/layout/PageContainer'
import { useViewEditorModal } from '@/components/layout/viewEditorContext'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { MANAGE_TEMPLATES } from '@/components/templates/AudiencePicker'
import { PromotionRequestsPanel } from '@/components/templates/PromotionRequestsPanel'
import { RequestPromotionDialog } from '@/components/templates/RequestPromotionDialog'
import { ShareTemplateDialog } from '@/components/templates/ShareTemplateDialog'
import { TemplateCard } from '@/components/templates/TemplateCard'
import { TemplateDetailDrawer } from '@/components/templates/TemplateDetailDrawer'
import { FeaturedShelf, RecentShelf } from '@/components/templates/TemplateShelves'
import { TemplateStudio, type StudioSeed } from '@/components/templates/TemplateStudio'
import { WorkspaceDefaultDialog } from '@/components/templates/WorkspaceDefaultDialog'
import {
    LIBRARY_TABS, canBeWorkspaceDefault, categoryLabel, type LibraryTab, type TemplateAction,
} from '@/components/templates/templateAudience'
import {
    fitShare, useFitWorkspaces, useTemplateFits, type TemplateFitScore,
} from '@/components/templates/useTemplateFits'
import {
    useDeleteLayoutTemplate, useInvalidateLayoutTemplates, useLayoutTemplate, useLayoutTemplates,
    usePromotionRequests, useSetLayoutTemplateHidden, useToggleTemplateFavourite,
} from '@/hooks/useLayoutTemplates'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { layoutTemplateService, type LayoutTemplate } from '@/services/layoutTemplateService'
import { checkPermission, usePermission, usePermissionClaims } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

type SortKey = 'updated' | 'used' | 'recent' | 'name' | 'match'

const SORTS: { id: SortKey; label: string }[] = [
    { id: 'updated', label: 'Recently updated' },
    { id: 'used', label: 'Most used' },
    { id: 'recent', label: 'Recently used by me' },
    { id: 'name', label: 'A–Z' },
    { id: 'match', label: 'Best match' },
]

function sortTemplates(list: LayoutTemplate[], key: SortKey, fits: Map<string, TemplateFitScore> | null): LayoutTemplate[] {
    return [...list].sort((a, b) => {
        if (key === 'used') return b.usageCount - a.usageCount || a.name.localeCompare(b.name)
        if (key === 'name') return a.name.localeCompare(b.name)
        if (key === 'recent') return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name)
        if (key === 'match' && fits) {
            const [fa, fb] = [fits.get(a.id), fits.get(b.id)]
            return fitShare(fb) - fitShare(fa) || (fb?.matched ?? 0) - (fa?.matched ?? 0) || b.usageCount - a.usageCount
        }
        return b.updatedAt.localeCompare(a.updatedAt)
    })
}

/** Drawer actions that change the template in place, so the drawer stays open. */
const IN_PLACE: ReadonlySet<TemplateAction> = new Set(['hide', 'show', 'feature', 'unfeature', 'withdraw'])

function TabEmptyState({ tab, isManager, onNew, onTab }: {
    tab: LibraryTab
    isManager: boolean
    onNew: () => void
    onTab: (tab: LibraryTab) => void
}) {
    const create = { label: 'New template', onClick: onNew, icon: Plus }
    switch (tab) {
        case 'favourites':
            return <EmptyState icon={Heart} title="Your favorite templates appear here"
                description="Tap the heart on any template to keep it one click away."
                secondaryAction={{ label: 'Browse all templates', onClick: () => onTab('all') }} />
        case 'mine':
            return <EmptyState icon={Sparkles} title="Templates you make appear here"
                description="Start from scratch, copy a built-in, or save a Context View's layers from its menu."
                action={create} secondaryAction={{ label: 'Browse built-ins', onClick: () => onTab('builtin') }} />
        case 'shared':
            return <EmptyState icon={Inbox} title="Nothing shared with you yet"
                description="When someone shares a template with you or a team you're in, it lands here — and in your inbox." />
        case 'workspace':
            return <EmptyState icon={Users} title="No workspace templates yet"
                description="Offer a layout to everyone in a workspace by choosing it as the template's audience."
                action={create} />
        case 'organization':
            return isManager
                ? <EmptyState icon={TemplateIcon} title="Publish your organization's first template"
                    description="A house layout everyone can start from. Choose Organization as its audience."
                    action={create} />
                : <EmptyState icon={TemplateIcon} title="No organization templates yet"
                    description="Your template managers haven't published one. Built-ins and your own templates are ready to use." />
        case 'builtin':
            return <EmptyState icon={Package} title="The built-in templates are hidden"
                description="An administrator hid them for everyone. Your own and your organization's templates are still here." />
        default:
            return <EmptyState icon={TemplateIcon} title="No templates yet" description="Create one to reuse a layer layout across views." action={create} />
    }
}

export function TemplatesPage() {
    useDocumentTitle('Templates')
    const navigate = useNavigate()
    const { templateId } = useParams<{ templateId?: string }>()
    const [searchParams, setSearchParams] = useSearchParams()
    const { notify } = useAppNotifications()
    const { openViewEditor } = useViewEditorModal()
    const isManager = usePermission(MANAGE_TEMPLATES)

    const [showHidden, setShowHidden] = useState(false)
    const { templates, isLoading, error, refetch } = useLayoutTemplates({ includeHidden: isManager && showHidden })
    const requests = usePromotionRequests(isManager)
    const deleteTemplate = useDeleteLayoutTemplate()
    const setHidden = useSetLayoutTemplateHidden()
    const toggleFavourite = useToggleTemplateFavourite()
    const invalidate = useInvalidateLayoutTemplates()

    const onRequests = isManager && searchParams.get('tab') === 'requests'
    const tab = (LIBRARY_TABS.find(t => t.id === searchParams.get('tab'))?.id ?? 'all') as LibraryTab
    const [query, setQuery] = useState('')
    const [category, setCategory] = useState<string | null>(null)
    const [sort, setSort] = useState<SortKey>('updated')
    const [studio, setStudio] = useState<StudioSeed | null>(null)
    const [sharing, setSharing] = useState<LayoutTemplate | null>(null)
    const [deleting, setDeleting] = useState<LayoutTemplate | null>(null)
    const [requesting, setRequesting] = useState<LayoutTemplate | null>(null)
    const [defaulting, setDefaulting] = useState<LayoutTemplate | null>(null)

    // "Fit for": how well each template matches a workspace's data. Until
    // someone picks, the active workspace — when its data is theirs to read.
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const [fitFor, setFitFor] = useState<string | null>()
    const fitChoices = useFitWorkspaces()
    const fitWorkspace = fitChoices.find(ws => ws.id === (fitFor === undefined ? activeWorkspaceId : fitFor)) ?? null
    const { fits } = useTemplateFits(templates, fitWorkspace)
    const sortBy = sort === 'match' && !fits ? 'updated' : sort

    // Workspaces whose new views this person decides the starting layout of.
    const adminWorkspaces = useMemo(
        () => workspaces.filter(ws => checkPermission(claims, 'workspace:admin', ws.id)),
        [workspaces, claims],
    )
    const defaultTargets = useCallback(
        (t: LayoutTemplate) => adminWorkspaces.filter(ws => canBeWorkspaceDefault(t, ws.id)),
        [adminWorkspaces],
    )

    const setTab = (next: LibraryTab | 'requests') => {
        setCategory(null)
        setSearchParams(p => {
            const out = new URLSearchParams(p)
            if (next === 'all') out.delete('tab'); else out.set('tab', next)
            return out
        }, { replace: true })
    }

    // `?new=1` (the Dashboard's "New template") opens the studio until it closes.
    const studioSeed = studio ?? (searchParams.get('new') ? {} : null)
    const closeStudio = useCallback(() => {
        setStudio(null)
        if (searchParams.get('new')) {
            setSearchParams(p => { const out = new URLSearchParams(p); out.delete('new'); return out }, { replace: true })
        }
    }, [searchParams, setSearchParams])

    const counts = useMemo(
        () => Object.fromEntries(LIBRARY_TABS.map(t => [t.id, templates.filter(t.match).length])) as Record<LibraryTab, number>,
        [templates],
    )
    const inTab = useMemo(
        () => templates.filter(LIBRARY_TABS.find(t => t.id === tab)!.match),
        [templates, tab],
    )
    const categories = useMemo(() => {
        const n = new Map<string, number>()
        for (const t of inTab) if (t.category) n.set(t.category, (n.get(t.category) ?? 0) + 1)
        return [...n.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }, [inTab])
    const allCategories = useMemo(
        () => [...new Set(templates.map(t => t.category).filter((c): c is string => !!c))],
        [templates],
    )
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        const filtered = inTab.filter(t =>
            (!category || t.category === category)
            && (!q || t.name.toLowerCase().includes(q)
                || (t.description ?? '').toLowerCase().includes(q)
                || t.layers.some(l => l.name.toLowerCase().includes(q))),
        )
        return sortTemplates(filtered, sortBy, fits)
    }, [inTab, category, query, sortBy, fits])
    const featured = useMemo(() => templates.filter(t => t.featured && !t.hidden), [templates])
    const recent = useMemo(
        () => templates.filter(t => t.lastUsedAt).sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!)).slice(0, 4),
        [templates],
    )
    const showShelves = tab === 'all' && !query.trim() && !category

    // The drawer's template: from the list when it is there, fetched when it is
    // not (a deep link, or a hidden built-in the list leaves out). Closing it
    // navigates in a transition; until that lands, a refetch that drops the
    // template (a request just declined) is not mistaken for it vanishing.
    const location = useLocation()
    const [closedAt, setClosedAt] = useState<string | null>(null)
    const closing = closedAt === location.key
    const listed = templates.find(t => t.id === templateId) ?? null
    const fetched = useLayoutTemplate(templateId && !listed && !isLoading && !closing ? templateId : null)
    const selected = closing ? null : listed ?? fetched.data ?? null
    useEffect(() => {
        if (fetched.isError) {
            notify('warning', "That template isn't available — it may have been deleted, or it isn't shared with you.")
            navigate('/templates', { replace: true })
        }
    }, [fetched.isError, navigate, notify])

    const closeDrawer = useCallback(() => {
        setClosedAt(location.key)
        navigate({ pathname: '/templates', search: searchParams.toString() })
    }, [location.key, navigate, searchParams])
    const openTemplate = useCallback(
        (t: LayoutTemplate) => navigate({ pathname: `/templates/${t.id}`, search: searchParams.toString() }),
        [navigate, searchParams],
    )

    const use = useCallback((t: LayoutTemplate) => {
        openViewEditor(undefined, { templateId: t.id })
    }, [openViewEditor])

    const run = useCallback((work: Promise<unknown>, done: string) => {
        work.then(() => notify('success', done))
            .catch((err: Error) => notify('error', err.message))
            .finally(() => void invalidate())
    }, [invalidate, notify])

    const act = useCallback((t: LayoutTemplate, action: TemplateAction) => {
        switch (action) {
            case 'use': return use(t)
            case 'edit': return setStudio({ template: t })
            case 'duplicate': return setStudio({
                name: `${t.name} (copy)`.slice(0, 80), description: t.description, category: t.category, layers: t.layers,
            })
            case 'share': return setSharing(t)
            case 'request': return setRequesting(t)
            case 'withdraw': return run(layoutTemplateService.withdrawPromotion(t.id), `Withdrew the request to offer "${t.name}" to everyone`)
            case 'feature': return run(layoutTemplateService.setFeatured(t.id, true), `"${t.name}" is featured at the top of everyone's library`)
            case 'unfeature': return run(layoutTemplateService.setFeatured(t.id, false), `"${t.name}" is no longer featured`)
            case 'default': return setDefaulting(t)
            case 'hide': return void setHidden(t, true)
            case 'show': return void setHidden(t, false)
            case 'delete': return setDeleting(t)
        }
    }, [use, setHidden, run])

    const renderCard = (t: LayoutTemplate) => {
        const score = fits?.get(t.id)
        return (
            <TemplateCard
                key={t.id}
                template={t}
                onOpen={() => openTemplate(t)}
                onAction={action => act(t, action)}
                onToggleFavourite={() => void toggleFavourite(t)}
                fit={score && fitWorkspace ? { ...score, workspaceName: fitWorkspace.name } : null}
                canSetDefault={defaultTargets(t).length > 0}
            />
        )
    }

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
            <PageContainer className="py-8 space-y-6 animate-in fade-in duration-500">
                {/* ── Header ── */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                            <TemplateIcon className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-ink leading-tight">Templates</h1>
                            <p className="text-[11px] text-ink-muted">
                                Reusable layer layouts for Context Views — yours, your teams' and your organization's
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setStudio({})}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200"
                    >
                        <Plus className="w-4 h-4" /> New template
                    </button>
                </div>

                {/* ── Tabs ── */}
                <div role="tablist" aria-label="Template collections" className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-700">
                    {[
                        ...LIBRARY_TABS.map(t => ({ id: t.id, label: t.label, count: isLoading ? null : counts[t.id] })),
                        ...(isManager ? [{ id: 'requests' as const, label: 'Requests', count: requests.data?.length ?? null }] : []),
                    ].map(t => {
                        const selected = onRequests ? t.id === 'requests' : tab === t.id
                        return (
                            <button
                                key={t.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                onClick={() => setTab(t.id)}
                                className={cn(
                                    'relative -mb-px flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium border-b-2 transition-colors',
                                    selected
                                        ? 'border-indigo-500 text-ink'
                                        : 'border-transparent text-ink-muted hover:text-ink',
                                )}
                            >
                                {t.label}
                                <span className={cn(
                                    'px-1.5 py-px rounded-full text-[10px] font-semibold tabular-nums',
                                    selected ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' : 'bg-black/5 dark:bg-white/5',
                                    t.id === 'requests' && !!t.count && !selected && 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
                                )}>
                                    {t.count ?? '–'}
                                </span>
                            </button>
                        )
                    })}
                </div>

                {onRequests ? (
                    <PromotionRequestsPanel requests={requests.data ?? []} isLoading={requests.isLoading} onOpen={openTemplate} />
                ) : (
                    <>
                        {/* ── Toolbar ── */}
                        <div className="flex flex-wrap items-center gap-3">
                            <div className="relative w-full sm:w-72">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                                <input
                                    type="search"
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="Search names, descriptions, layers"
                                    aria-label="Search templates"
                                    className="input border-slate-200 dark:border-slate-700 w-full h-9 pl-9 text-sm bg-canvas-elevated"
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                                {categories.map(([c, n]) => (
                                    <button
                                        key={c}
                                        type="button"
                                        aria-pressed={category === c}
                                        onClick={() => setCategory(category === c ? null : c)}
                                        className={cn(
                                            'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                                            category === c
                                                ? 'bg-indigo-500 text-white border-indigo-500'
                                                : 'border-slate-200 dark:border-slate-700 text-ink-muted hover:text-ink bg-canvas-elevated',
                                        )}
                                    >
                                        {categoryLabel(c)}
                                        <span className={cn('tabular-nums', category === c ? 'text-white/80' : 'text-ink-muted/70')}>{n}</span>
                                        {category === c && <X className="w-3 h-3" />}
                                    </button>
                                ))}
                            </div>
                            <div className="ml-auto flex flex-wrap items-center gap-3">
                                {fitChoices.length > 0 && (
                                    <label className="flex items-center gap-2 text-xs text-ink-muted whitespace-nowrap">
                                        Fit for
                                        <select
                                            value={fitWorkspace?.id ?? ''}
                                            onChange={e => setFitFor(e.target.value || null)}
                                            aria-label="Show how well templates fit a workspace's data"
                                            className="input border-slate-200 dark:border-slate-700 h-9 text-sm bg-canvas-elevated"
                                        >
                                            <option value="">No workspace</option>
                                            {fitChoices.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                                        </select>
                                    </label>
                                )}
                                {isManager && (
                                    <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none whitespace-nowrap">
                                        <input
                                            type="checkbox"
                                            checked={showHidden}
                                            onChange={e => setShowHidden(e.target.checked)}
                                            className="rounded border-slate-200 dark:border-slate-700"
                                        />
                                        Show hidden built-ins
                                    </label>
                                )}
                                <select
                                    value={sortBy}
                                    onChange={e => setSort(e.target.value as SortKey)}
                                    aria-label="Sort templates"
                                    className="input border-slate-200 dark:border-slate-700 h-9 text-sm bg-canvas-elevated"
                                >
                                    {SORTS.filter(s => s.id !== 'match' || fits).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                                </select>
                            </div>
                        </div>

                        {/* ── Shelves: featured, and what this person used last ── */}
                        {showShelves && !isLoading && (
                            <>
                                <FeaturedShelf templates={featured} renderCard={renderCard} />
                                <RecentShelf templates={recent} onOpen={openTemplate} onUse={use} />
                            </>
                        )}

                        {/* ── Library ── */}
                        {error && !isLoading && templates.length === 0 ? (
                            <div role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/[0.05] px-5 py-4 flex items-center gap-3">
                                <p className="text-sm text-ink flex-1">The template library couldn't be loaded: {error.message}</p>
                                <button type="button" onClick={() => void refetch()} className="text-sm font-semibold text-red-600 dark:text-red-400 hover:underline">
                                    Try again
                                </button>
                            </div>
                        ) : isLoading ? (
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 wide:grid-cols-4">
                                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[236px] rounded-2xl" />)}
                            </div>
                        ) : shown.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 bg-canvas-elevated/40">
                                {query || category ? (
                                    <EmptyState
                                        icon={Search}
                                        title={query ? `Nothing matches "${query}"` : 'No templates in this category'}
                                        description="Try another word, or clear the filters to see the whole collection."
                                        action={{ label: 'Clear filters', onClick: () => { setQuery(''); setCategory(null) } }}
                                    />
                                ) : (
                                    <TabEmptyState tab={tab} isManager={isManager} onNew={() => setStudio({})} onTab={setTab} />
                                )}
                            </div>
                        ) : (
                            <section className="space-y-3">
                                {showShelves && (featured.length > 0 || recent.length > 0) && (
                                    <h2 className="text-sm font-bold text-ink">All templates</h2>
                                )}
                                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 wide:grid-cols-4">
                                    {shown.map(renderCard)}
                                </div>
                            </section>
                        )}
                    </>
                )}
            </PageContainer>

            <TemplateDetailDrawer
                template={selected}
                open={!!templateId && !!selected}
                onClose={closeDrawer}
                onAction={(t, action) => {
                    // The studio, the dialogs and the wizard open over the page, not over the drawer.
                    if (!IN_PLACE.has(action)) closeDrawer()
                    act(t, action)
                }}
                onToggleFavourite={t => void toggleFavourite(t)}
                canSetDefault={!!selected && defaultTargets(selected).length > 0}
            />

            {studioSeed && (
                <TemplateStudio
                    seed={studioSeed}
                    categories={allCategories}
                    onClose={closeStudio}
                    onShare={t => { closeStudio(); setSharing(t) }}
                    onUse={t => { closeStudio(); use(t) }}
                />
            )}
            {sharing && <ShareTemplateDialog template={sharing} onClose={() => setSharing(null)} />}
            {requesting && <RequestPromotionDialog template={requesting} onClose={() => setRequesting(null)} />}
            {defaulting && (
                <WorkspaceDefaultDialog template={defaulting} workspaces={defaultTargets(defaulting)} onClose={() => setDefaulting(null)} />
            )}
            <ConfirmDialog
                open={!!deleting}
                title={deleting ? `Delete "${deleting.name}"?` : ''}
                message={deleting ? [
                    deleting.usageCount > 0
                        ? `${deleting.usageCount} view${deleting.usageCount === 1 ? '' : 's'} built from it keep their layers.`
                        : 'No views use it.',
                    deleting.grantCount
                        ? `The ${deleting.grantCount} ${deleting.grantCount === 1 ? 'person or team' : 'people and teams'} it is shared with lose it.`
                        : '',
                    'You can undo this for a few seconds afterwards.',
                ].filter(Boolean).join(' ') : ''}
                confirmLabel="Delete"
                confirmIcon={Trash2}
                onCancel={() => setDeleting(null)}
                onConfirm={() => {
                    const t = deleting
                    setDeleting(null)
                    if (!t) return
                    void deleteTemplate(t)
                }}
            />
        </div>
    )
}
