/**
 * ViewPageHeader — the identity + actions bar for the full-canvas view page.
 *
 * Three gaps this closes.
 *
 * 1. The view had NO identity on screen. Its name lived only in the browser tab
 *    title — open two views side by side and the canvases are indistinguishable.
 *
 * 2. Details and Activity were unreachable from the place people actually work.
 *    Both existed, but only inside the Explorer's preview drawer: to rename a view
 *    or see who changed it, you had to leave the canvas, go to the Explorer, find
 *    the view again and open its drawer. The full-canvas page — where users spend
 *    their time — could do neither.
 *
 * 3. The view never said what it was BUILT ON. Which system the data comes
 *    from, which graph database serves it and which semantic layer it is read
 *    through were all knowable and none of them was on screen — a user could
 *    only guess what they were looking at. The data source now rides in the
 *    identity line, and opens the full account (ViewBuiltOn) inside this same
 *    sheet. It is deliberately NOT a second trigger for the edit form: the
 *    Details button is `canEditDetails`-gated, and the person most likely to
 *    ask "what is this?" is exactly the viewer who never had that button.
 *
 * 4. A pending ask to publish the view was invisible ON the view. It surfaced
 *    only in the workspace admin queue and inside the Share dialog, so nobody
 *    looking at the view knew a decision about its audience was outstanding —
 *    including the admin who could answer it.
 *
 * THE LAYOUT SAYS WHAT EACH THING IS. It used to be one baseline row of
 * ~10px chips at a single weight, so a WORKSPACE (a place), a VIEW TYPE (a
 * kind) and two bare numbers all read as the same sort of token, and the name
 * barely led. Three bands now, each answering one question:
 *
 *   1. WHAT IS THIS — the name, largest, with the badges that change what you
 *      may do beside it (read-only, a publication decision outstanding).
 *   2. WHERE DOES IT LIVE — kind, workspace, data source. One icon and one
 *      colour per concept, the same ones the Explorer and the built-on account
 *      use, so recognition carries between surfaces.
 *   3. IS ANYONE USING IT — figures that carry their unit and their window.
 *
 * The right cluster is CONTROLS, not chrome, and it is TWO groups, not four
 * lookalike buttons: Share — the one outward-facing action, bordered, carrying
 * the audience's own icon — then a rule, then the three quiet "tell me about
 * this view" buttons, Details, Activity and Reviews.
 *
 * 5. The canvas toolbar underneath printed the SAME view name and a type count
 *    a second time, and hid Edit details / Share / rename behind a chevron on
 *    it — while a third band in between held a branch switcher and Reviews.
 *    The duplicate title is gone. Its dropdown's two actions were already here
 *    (Details opens the same metadata form; Share opens the same dialog),
 *    rename-on-double-click came with the surviving name, the type count joined
 *    the identity line, and Reviews joined this cluster.
 *
 * 6. Sharing was gated on being able to NAME the audience, and so went missing
 *    on exactly the views that predate the tier vocabulary: the visibility
 *    column still permits the legacy 'public', a value no per-tier map has a
 *    key for, and the whole control was withheld rather than render a broken
 *    chip — taking the only route to the Share dialog with it, for an owner
 *    holding every sharing right. Naming the tier and offering the action are
 *    now separate questions.
 *
 * Colour is spent on meaning: the view type's hue lives in the icon tile alone.
 * A gradient wash across the bar was tried and removed — the bar is chrome, and
 * tinting the whole of it competed with the canvas it sits above.
 *
 * It renders ABOVE the canvas rather than over it. The canvas corners are already
 * spoken for (search trigger top-right at z-30, minimap and controls, transient
 * notifications at top-20), so a floating cluster would have landed on top of something.
 *
 * Both panels are the SHARED components — EditDetailsPanel (lifted out of
 * ExplorerPreviewDrawer, where it was private) and ViewActivityDrawer. One
 * component, two hosts: the Explorer and the canvas cannot drift into showing
 * different edit forms for the same view.
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Boxes, Clock, Database, Eye, History, Info, Pencil, Shapes, Share2, X } from 'lucide-react'
import { ViewUsageBadge } from './ViewUsageBadge'
import { cn } from '@/lib/utils'
import {
    DynamicIcon, resolveViewIcon, viewTypeColor, viewTypeMeta, viewTypeLabel,
} from '@/lib/viewUtils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { ViewReviewsButton } from '@/features/versioning/components/ViewReviewsButton'
import { ViewPrIndicator } from '@/features/versioning/components/ViewPrIndicator'
import { useViewPrCounts } from '@/features/versioning/hooks/useVersioning'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'
import { EditDetailsPanel } from '@/components/views/EditDetailsPanel'
import { ViewBuiltOn } from '@/components/views/ViewBuiltOn'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { timeAgo } from '@/lib/timeAgo'
import {
    VISIBILITY_ACCENT, VISIBILITY_ICON, isKnownVisibility,
    visibilityDescription, visibilityLabel,
} from '@/lib/viewVisibility'
import { workspaceColor } from '@/lib/workspaceColor'
import { getView, updateView, type View } from '@/services/viewApiService'
import { useBrand } from '@/store/branding'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'

/** Literal class strings — Tailwind's JIT scans source text, so these can
 *  never be built by interpolation. Shared by each badge's two forms
 *  (button when the caller can act, plain chip when they can't). */
const PENDING_BADGE = 'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400 shrink-0'
/** The quiet group: Details, Activity, Reviews. Share is deliberately NOT one
 *  of them — it is bordered, so the action that reaches other people does not
 *  read as a fourth way to look something up. */
const ACTION_BUTTON_BASE = 'inline-flex items-center gap-1.5 rounded-lg font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500'
/**
 * Two sizes, and which one is used depends on whether the review chip is under
 * them.
 *
 * That chip — "N from this view · N on data source" — used to hold a band of
 * its own between this header and the canvas toolbar. It is the one thing in
 * `CanvasVersioningBar` that is NOT transient: the other chips appear while a
 * projection or a rollup catches up and then go, whereas one open review kept a
 * whole band alive for as long as it stood open, which read as a dead strip.
 *
 * It sits under this cluster now. When it is absent — an external graph with no
 * version control at all, or a versioned one with nothing open — the cluster
 * takes the line back and spends it on itself, because four small controls in a
 * wide header can afford to be legible.
 */
const ACTION_BUTTON = `${ACTION_BUTTON_BASE} px-2.5 py-1.5 text-xs`
const ACTION_BUTTON_ROOMY = `${ACTION_BUTTON_BASE} px-3 py-2 text-[13px]`
/** An identity fact: quiet by default, a real hover target when it goes
 *  somewhere. The negative margin keeps the hover chip from pushing the run
 *  of facts apart — it grows into its own gap. */
const IDENTITY_ITEM = 'inline-flex items-center gap-1 min-w-0'
const IDENTITY_LINK = '-mx-1 px-1 py-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500'

/** The details sheet's two errands. ABOUT is what this view rests on;
 *  EDIT is the metadata form. Ordered as they are offered. */
type DetailsTab = 'about' | 'edit'
const DETAILS_TABS: { id: DetailsTab; label: string; icon: typeof Info }[] = [
    { id: 'about', label: 'About', icon: Info },
    { id: 'edit', label: 'Edit', icon: Pencil },
]

/** Provenance dates read as dates, not timestamps — the same format the
 *  canvas's Edit-details dialog used before this sheet replaced it. */
function shortDate(value: string): string {
    return new Date(value).toLocaleDateString()
}

/** How many entity-type names a tooltip will list before it starts counting
 *  instead. Beyond this the list is no longer readable at a glance. */
const TYPES_IN_TIP = 6

/** The separator between two facts on one line. */
function Dot() {
    return <span aria-hidden className="text-ink-muted">·</span>
}

export function ViewPageHeader({ viewId, workspaceName }: {
    viewId: string
    workspaceName?: string
}) {
    const [activityOpen, setActivityOpen] = useState(false)
    // The details sheet is TABBED, and which tab you land on is decided by the
    // affordance you used. Someone who clicked a pencil came to change
    // something; someone who clicked the data source came to find out what
    // this thing is. Landing both of them on the same essay-then-form scroll
    // is what made this panel unusable for either.
    const [details, setDetails] = useState<DetailsTab | null>(null)
    // Which tab the sheet was OPENED on, cleared the instant the reader picks a
    // different one. It is what decides whether a panel may take focus on
    // mount: arriving at the Edit form because you opened the editor should put
    // the cursor in Name, but arriving because you ARROWED onto its tab must
    // not — that yanks focus out of the tab strip and strands a keyboard user
    // in a text field, unable to arrow back.
    const [entry, setEntry] = useState<DetailsTab | null>(null)
    const detailsOpen = details !== null
    const openDetails = (tab: DetailsTab) => { setDetails(tab); setEntry(tab) }
    const chooseTab = (tab: DetailsTab) => { setDetails(tab); setEntry(null) }
    const closeDetails = () => { setDetails(null); setEntry(null) }
    // Stable ids so each tab can point at the panel and the panel back at the
    // selected tab — the wiring a screen reader needs to announce the pair.
    const sheetId = useId()

    /**
     * The arrow-key half of the tabs pattern: one tab stop for the whole
     * strip (roving tabindex above), left/right to move within it, and
     * selection FOLLOWS focus because both panels are instant. Reads the
     * buttons off the tablist it is bound to, so there is no second list to
     * keep in step with DETAILS_TABS.
     */
    const handleTabKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!delta) return
        e.preventDefault()
        const tabs = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        )
        const from = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true')
        const next = tabs[(from + delta + tabs.length) % tabs.length]
        if (!next) return
        chooseTab(next.dataset.tab as DetailsTab)
        next.focus()
    }
    const [shareOpen, setShareOpen] = useState(false)
    // Double-click the name to rename it — the affordance came up with the name
    // when the canvas toolbar's duplicate title was removed. The long way round
    // (Details → Name) is unchanged; this is the shortcut people already had.
    const [renaming, setRenaming] = useState(false)
    const { notify } = useAppNotifications()
    const queryClient = useQueryClient()
    const updateViewInStore = useSchemaStore(s => s.updateView)
    const appName = useBrand().appName
    // Membership-scoped by construction: the store lists only workspaces the
    // caller belongs to. That is exactly the test for "will /workspaces/{id}
    // open for this person?", so a shared/enterprise viewer gets the name as
    // plain text instead of a link into a page that would refuse them.
    const myWorkspaces = useWorkspacesStore(s => s.workspaces)

    // The canvas store holds a ViewConfiguration — the canvas's own shape, missing
    // visibility/tags/config that the edit form needs. So take the authoritative
    // View from the API, on the SAME query key useViewMetadata uses: React Query
    // caches the raw response and applies `select` per observer, so this shares
    // that fetch instead of duplicating it.
    const { data: view } = useQuery({
        queryKey: [...VIEW_QUERY_KEY, viewId],
        queryFn: () => getView(viewId),
        enabled: Boolean(viewId),
    })

    // Whether the review chip will render, which decides how much room the
    // actions above it get. Shares the chip's own query key, so asking here
    // costs no request — and the chip is about to ask for exactly this.
    //
    // ABOVE THE `!view` GUARD, because everything below it is unreachable on
    // the first render and a hook called there would change the hook count the
    // moment the view arrives. `useViewPrCounts` is `enabled`-gated on both
    // arguments, so an undefined workspace simply asks nothing.
    //
    // An EXTERNAL graph never has counts at all — the chip is scoped to a view
    // whose data source is versioned, and the versioning bar it came from never
    // rendered without one. So an unversioned view lands in the roomier layout
    // by construction rather than by a special case for it.
    const openVersioningPanel = useVersioningPanelStore((st) => st.openPanel)
    const { data: prCounts } = useViewPrCounts(view?.workspaceId, view?.id)
    const hasOpenReviews = ((prCounts?.fromView ?? 0) + (prCounts?.onDataSource ?? 0)) > 0
    const actionButtonClass = hasOpenReviews ? ACTION_BUTTON : ACTION_BUTTON_ROOMY

    if (!view) return null

    const meta = viewTypeMeta(view.viewType)
    const icon = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })
    // The tile carries the view's OWN icon (a wizard choice, when there was
    // one); the identity line carries its type's canonical icon, so the kind
    // is legible even on a view whose author picked something else.
    const typeIcon = resolveViewIcon({ viewType: view.viewType })

    // The caller's capability envelope rides on the same response. Without
    // it (older backend), keep the legacy always-visible behavior — the
    // backend still enforces on save.
    const access = view.access ?? null
    const canEditDetails = access ? access.canEdit : true
    const readOnly = access?.dataAccess === 'readonly'


    // Never a raw id in the identity line — it has one line and an id spends
    // it on nothing. The full account can still print the id as a last resort.
    const builtOnLabel = view.dataSourceName ?? 'Data source'
    // How many entity types this view shows. It rode the canvas toolbar's
    // subtitle ("2 types · Context View") until that duplicate title block was
    // removed; the count is a fact about the view, so it joined the line of
    // facts. Free — the same config blob the header already fetched carries it.
    const visibleEntityTypes = view.config?.content?.visibleEntityTypes
    const entityTypeCount = Array.isArray(visibleEntityTypes) ? visibleEntityTypes.length : 0
    // WHICH types, not how many — the count is already on the surface, so a
    // tip that only restates it teaches people that hovering is not worth
    // doing. Capped: past a handful the list stops being readable at a glance
    // and the remainder is a number again.
    const typeNames = (Array.isArray(visibleEntityTypes) ? visibleEntityTypes : [])
        .filter((t): t is string => typeof t === 'string')
    const namedTypes = typeNames.slice(0, TYPES_IN_TIP).join(', ')
        + (typeNames.length > TYPES_IN_TIP
            ? `, and ${typeNames.length - TYPES_IN_TIP} more`
            : '')
    const wsTint = workspaceColor(view.workspaceId).text
    const isMember = myWorkspaces.some(w => w.id === view.workspaceId)

    // SHARING, and the audience it changes. Two independent questions, and
    // conflating them is what cost this header the canvas title menu's
    // "Share…" item: the database's visibility column is wider than the three
    // tiers this app can NAME (`ck_views_visibility` still permits the legacy
    // 'public', and live rows carry it), so gating the control on a nameable
    // tier left a view whose owner holds every sharing right with no route to
    // the dialog at all. The tier decides what the control can SAY; the
    // capability decides whether it is a control.
    const visibility = isKnownVisibility(view.visibility) ? view.visibility : null
    const VisibilityIcon = visibility ? VISIBILITY_ICON[visibility] : null
    const canOpenSharing = access
        ? Boolean(access.canManageGrants || access.canChangeVisibility
            || access.canRequestPublish || access.canAnswerPublishRequest)
        : true
    // One control, not two. The old menu offered "Share…" and, below it, a
    // read-only row naming the tier; both are this button — the verb is the
    // label (it is what people come looking for), the audience is the icon and
    // the sentence on hover.
    // No trailing full stop — every tip on this bar is a fragment or a single
    // sentence and they all end the same way, which is half of what "one
    // voice" means.
    const shareTip = visibility
        ? `Who can see this view: ${visibilityDescription(visibility, { appName, workspaceName })}`
        : 'Choose who can see this view, and who to share it with'

    // A pending ask to publish is state OF THE VIEW, so it belongs on the
    // view — not only in the admin queue and the Share dialog, which is
    // where it used to be hiding. Anyone looking at the view sees that a
    // decision is outstanding; only someone who can answer gets a route in.
    const pendingRequest = view.publishRequest ?? null
    const canAnswerRequest = access?.canAnswerPublishRequest ?? false
    // WHO asked and WHEN — the detail line. What to do about it is the lead,
    // and it differs by who is reading, so the two are no longer one string.
    const requestTip = pendingRequest
        ? `Asked by ${pendingRequest.requestedByName ?? 'a workspace member'}`
            + ` ${timeAgo(pendingRequest.requestedAt)}`
        : undefined

    // Same path a Details save takes, so both routes to a new name settle the
    // caches identically; a failure says so and leaves the name as it was.
    const handleRename = (name: string) => {
        setRenaming(false)
        updateView(viewId, { name })
            .then(handleSaved)
            .catch(err => notify('error', err instanceof Error ? err.message : 'Failed to rename view'))
    }

    const handleSaved = (updated: View) => {
        closeDetails()
        queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, viewId] })
        queryClient.invalidateQueries({ queryKey: ['views'] })
        // The canvas reads its view from the schema store, not React Query — without
        // this a rename would update the header and leave the canvas (and the tab
        // title, which is derived from it) showing the old name until a reload.
        updateViewInStore(viewId, { name: updated.name })
    }

    return (
        <>
            <header className="relative flex items-start gap-3 px-4 py-2.5 border-b border-glass-border bg-canvas-elevated shrink-0">

                {/* The tile is the only colour-coded identity on the bar and
                    it explained nothing: the hue IS the view type, and nothing
                    said so. */}
                <HoverTip
                    className="shrink-0"
                    label={viewTypeLabel(view.viewType)}
                    detail={meta.what}
                >
                    <span className={cn(
                        'relative mt-0.5 h-9 w-9 rounded-xl border flex items-center justify-center shrink-0',
                        meta.iconBg,
                    )}>
                        <DynamicIcon name={icon} className="h-[18px] w-[18px]" />
                    </span>
                </HoverTip>

                <div className="relative min-w-0 flex-1">
                    {/* 1 — what this is. The name leads at a size nothing else
                        on the bar competes with; only the two badges that
                        change what you may do sit beside it. */}
                    <div className="flex items-center gap-2 min-w-0">
                        {renaming ? (
                            <RenameInput
                                defaultValue={view.name}
                                onCommit={handleRename}
                                onCancel={() => setRenaming(false)}
                            />
                        ) : (
                            /* THE ONE SHAPE `title` SURVIVES ON: a
                               non-interactive text node that truncates, where
                               the tip's text IS the full value of that node.
                               Everything else on this bar is a HoverTip.

                               It used to spend this on "Double-click to
                               rename" for editors — so the people most likely
                               to have long names were the only ones who could
                               not read them. The rename hint moved to the
                               Details button, which is an affordance. */
                            <h1
                                className="text-[15px] font-bold text-ink leading-tight truncate"
                                title={view.name}
                                onDoubleClick={canEditDetails ? () => setRenaming(true) : undefined}
                            >
                                {view.name}
                            </h1>
                        )}
                        {readOnly && (
                            <HoverTip
                                className="inline-flex shrink-0"
                                label="Explore everything here — expand, trace and search"
                                detail="Nothing in this view can be changed"
                            >
                                <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400 shrink-0">
                                    <Eye className="w-3 h-3" aria-hidden />
                                    {/* "Shared with you" is only true for grant/enterprise
                                        reach — a workspace viewer on their own workspace's
                                        views just has read-only rights, nothing was shared. */}
                                    {access?.accessVia === 'grant' || access?.accessVia === 'enterprise'
                                        ? 'Shared with you · read-only'
                                        : 'Read-only'}
                                </span>
                            </HoverTip>
                        )}
                        {pendingRequest && (canAnswerRequest ? (
                            <HoverTip
                                className="inline-flex shrink-0"
                                label="Open sharing to approve or decline this request"
                                detail={requestTip}
                            >
                                <button
                                    type="button"
                                    onClick={() => setShareOpen(true)}
                                    aria-label="Publication requested — open sharing to approve or decline"
                                    className={cn(PENDING_BADGE, 'hover:bg-amber-500/20 transition-colors')}
                                >
                                    <Clock className="w-3 h-3" aria-hidden />
                                    Publication requested
                                </button>
                            </HoverTip>
                        ) : (
                            <HoverTip
                                className="inline-flex shrink-0"
                                label="A workspace admin decides whether this view is published"
                                detail={requestTip}
                            >
                                <span className={PENDING_BADGE}>
                                    <Clock className="w-3 h-3" aria-hidden />
                                    Publication requested
                                </span>
                            </HoverTip>
                        ))}
                    </div>

                    {/* 2 — where it lives. A KIND, a PLACE and a SOURCE are
                        three different sorts of fact; each gets its own icon
                        and its own colour, and the two that go somewhere are
                        real targets rather than dot-separated prose. */}
                    <div className="mt-1 flex items-center gap-2 min-w-0 text-[11px] font-medium text-ink-secondary">
                        {/* "Context View" is two words most people meet for the
                            first time on this bar. The kind of view decides how
                            the canvas behaves, and nothing said what it was. */}
                        <HoverTip className={cn(IDENTITY_ITEM, 'shrink-0')} label={meta.what}>
                            <span className={IDENTITY_ITEM}>
                                <DynamicIcon
                                    name={typeIcon}
                                    className={cn('h-3 w-3 shrink-0', viewTypeColor(view.viewType))}
                                />
                                {viewTypeLabel(view.viewType)}
                            </span>
                        </HoverTip>

                        {/* How much of the model this view shows — next to the
                            KIND of view, which is the fact it qualifies. */}
                        {entityTypeCount > 0 && (
                            <>
                                <Dot />
                                <HoverTip
                                    className={cn(IDENTITY_ITEM, 'shrink-0')}
                                    label="This view is scoped to these entity types — nothing else reaches the canvas"
                                    detail={namedTypes || undefined}
                                >
                                    <span className={IDENTITY_ITEM}>
                                        <Shapes className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
                                        {entityTypeCount} type{entityTypeCount === 1 ? '' : 's'}
                                    </span>
                                </HoverTip>
                            </>
                        )}

                        {workspaceName && (
                            <>
                                <Dot />
                                {isMember ? (
                                    <HoverTip
                                        className={cn(IDENTITY_ITEM, 'min-w-0')}
                                        label={`Open the ${workspaceName} workspace`}
                                        detail="Leaves the canvas"
                                    >
                                        <Link
                                            to={`/workspaces/${view.workspaceId}`}
                                            aria-label={`Open the ${workspaceName} workspace`}
                                            className={cn(IDENTITY_ITEM, IDENTITY_LINK)}
                                        >
                                            <Boxes className={cn('h-3 w-3 shrink-0', wsTint)} aria-hidden />
                                            <span className="truncate">{workspaceName}</span>
                                            <ArrowUpRight className="h-2.5 w-2.5 shrink-0 text-ink-muted" aria-hidden />
                                        </Link>
                                    </HoverTip>
                                ) : (
                                    /* A name that truncates with no way to read
                                       it, and no explanation of why it is the
                                       one fact here that goes nowhere. */
                                    <HoverTip
                                        className={cn(IDENTITY_ITEM, 'min-w-0')}
                                        label={workspaceName}
                                        detail="You are not a member of this workspace, so it cannot be opened from here"
                                    >
                                        <span className={IDENTITY_ITEM}>
                                            <Boxes className={cn('h-3 w-3 shrink-0', wsTint)} aria-hidden />
                                            <span className="truncate">{workspaceName}</span>
                                        </span>
                                    </HoverTip>
                                )}
                            </>
                        )}

                        {/* What this view is built on. The data source name is
                            already on the response the header fetched, so the
                            indicator itself costs nothing; the provider and
                            semantic layer are looked up only when this opens.
                            Neutral on purpose — emerald is this app's health
                            colour, and an emerald data source beside a row of
                            state badges reads as "this source is fine". */}
                        {view.dataSourceId && (
                            <>
                                <Dot />
                                <HoverTip
                                    className="hidden sm:inline-flex min-w-0"
                                    label={`Everything on this canvas is drawn from ${builtOnLabel}`}
                                    detail="Opens the data source, graph data provider and semantic layer behind this view"
                                >
                                    <button
                                        type="button"
                                        onClick={() => openDetails('about')}
                                        aria-label={`What this view is built on: ${builtOnLabel}`}
                                        className={cn(IDENTITY_ITEM, IDENTITY_LINK, 'max-w-[180px]')}
                                    >
                                        <Database className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
                                        <span className="truncate">{builtOnLabel}</span>
                                    </button>
                                </HoverTip>
                            </>
                        )}
                    </div>

                    {/* 3 — how much this view is actually used, on the view.
                        The platform always knew; it only ever said so on a
                        dashboard the person who built this has no reason to
                        open. Renders nothing while loading or on failure. */}
                    <ViewUsageBadge viewId={viewId} className="mt-1 hidden md:inline-flex" />
                </div>

                {/* The action cluster, and UNDER IT the review chip.
                    That chip used to hold a band of its own between this header
                    and the canvas toolbar — and it is the one thing in
                    `CanvasVersioningBar` that is not transient, so a single
                    open review kept a whole strip alive for as long as it stood
                    open, reading as dead chrome. It belongs with the controls
                    it points at. */}
                <div className="relative ml-auto flex flex-col items-end gap-1 shrink-0">
                <div className="flex items-center gap-1">
                    {/* SHARE — the one outward-facing action, and the only
                        bordered control here, so it reads as a different sort
                        of thing from the three quiet "tell me about this view"
                        buttons that follow. The tier's own icon rides on it, so
                        the current audience is still legible at a glance.

                        Someone who can change nothing about the audience gets
                        no verb — just the tier, as a badge, which is all the
                        old menu's read-only row ever gave them. */}
                    {canOpenSharing ? (
                        <HoverTip className="inline-flex" label={shareTip} detail="Opens sharing">
                            <button
                                type="button"
                                onClick={() => setShareOpen(true)}
                                aria-label={visibility
                                    ? `Share — who can see this view: ${visibilityLabel(visibility)}`
                                    : 'Share'}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                            >
                                {visibility && VisibilityIcon
                                    ? <VisibilityIcon className={cn('h-3.5 w-3.5', VISIBILITY_ACCENT[visibility].iconText)} aria-hidden />
                                    : <Share2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />}
                                <span className="hidden sm:inline">Share</span>
                            </button>
                        </HoverTip>
                    ) : visibility && VisibilityIcon ? (
                        <HoverTip className="inline-flex" label={shareTip}>
                            <span
                                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1.5 text-xs font-semibold text-ink-muted"
                                aria-label={`Who can see this view: ${visibilityLabel(visibility)}`}
                            >
                                <VisibilityIcon className={cn('h-3.5 w-3.5', VISIBILITY_ACCENT[visibility].iconText)} aria-hidden />
                                <span className="hidden sm:inline">{visibilityLabel(visibility)}</span>
                            </span>
                        </HoverTip>
                    ) : null}

                    <span aria-hidden className="mx-0.5 h-5 w-px bg-glass-border" />

                    {canEditDetails && (
                        <HoverTip
                            className="inline-flex"
                            label="Rename, describe, tag, or change who can see this view"
                            detail="Double-click the view's name to rename it in place"
                        >
                            <button
                                type="button"
                                onClick={() => openDetails('edit')}
                                className={actionButtonClass}
                                aria-label="Details"
                            >
                                <Pencil className="w-3.5 h-3.5" aria-hidden />
                                <span className="hidden lg:inline">Details</span>
                            </button>
                        </HoverTip>
                    )}

                    <HoverTip
                        className="inline-flex"
                        label="Who changed this view, and when its data was last refreshed"
                    >
                        <button
                            type="button"
                            onClick={() => setActivityOpen(true)}
                            className={actionButtonClass}
                            aria-label="Activity"
                        >
                            <History className="w-3.5 h-3.5" aria-hidden />
                            <span className="hidden lg:inline">Activity</span>
                        </button>
                    </HoverTip>

                    {/* Came up from CanvasVersioningBar, which held it and the
                        branch switcher and nothing else. A read-only session
                        gets no versioning chrome at all (CanvasRouter mounts
                        none), so it must not get a route into it either. */}
                    {!readOnly && (
                        <ViewReviewsButton
                            workspaceId={view.workspaceId}
                            dataSourceId={view.dataSourceId ?? null}
                            viewId={view.id}
                            className={actionButtonClass}
                        />
                    )}
                </div>

                {/* Renders nothing when there is nothing open, which is what
                    lets the row above take the space back. A read-only session
                    gets no versioning chrome at all, so it gets no route into
                    it either — the same rule the Reviews button follows. */}
                {!readOnly && hasOpenReviews && (
                    <ViewPrIndicator
                        wsId={view.workspaceId}
                        viewId={view.id}
                        onOpen={() => openVersioningPanel('prs')}
                    />
                )}
                </div>
            </header>

            {/* Details — an inline sheet, not a portal: the canvas below keeps its
                own overlays, and this stays scoped to the page.

                TWO TABS, and the affordance you used picks the one you land on.
                It used to be one scroll: three grey blocks of label + value +
                explanatory paragraph, and only THEN the form — so an editor who
                came to rename the view met an essay first, and a viewer who came
                to ask "what is this?" got the answer buried under prose about
                what the words meant. Facts and editing are two different errands.

                Only the selected panel is mounted, which is also what keeps the
                built-on account's two lookups off an Edit-first open. */}
            {detailsOpen && (
                <div
                    className="absolute inset-0 z-[60] flex justify-end"
                    onKeyDown={e => { if (e.key === 'Escape') closeDetails() }}
                >
                    <button
                        type="button"
                        aria-label="Close details"
                        onClick={closeDetails}
                        className="absolute inset-0 bg-black/20 backdrop-blur-[2px]"
                    />
                    <aside
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={`${sheetId}-title`}
                        className="relative w-full max-w-md h-full overflow-y-auto custom-scrollbar bg-canvas border-l border-glass-border shadow-2xl"
                    >
                        <div className="sticky top-0 z-10 bg-canvas border-b border-glass-border">
                            <div className="flex items-center justify-between px-5 pt-3 pb-2">
                                <h2 id={`${sheetId}-title`} className="text-sm font-bold text-ink">View details</h2>
                                <button
                                    type="button"
                                    onClick={closeDetails}
                                    aria-label="Close details"
                                    /* Opening on Edit autofocuses the Name field; opening
                                       on About has no target of its own, so focus would be
                                       left outside the sheet. Evaluated at MOUNT, so
                                       switching tabs later never steals focus back. */
                                    autoFocus={entry === 'about'}
                                    className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            {/* One errand, one tab. A viewer has only About to see,
                                and a strip of one is not a choice — so they get none. */}
                            {canEditDetails && (
                                <div
                                    role="tablist"
                                    aria-label="View details sections"
                                    onKeyDown={handleTabKeys}
                                    className="mx-5 mb-3 inline-flex items-center gap-1 rounded-xl border border-black/[0.06] bg-black/[0.03] p-1 dark:border-white/[0.08] dark:bg-white/[0.04]"
                                >
                                    {DETAILS_TABS.map(({ id, label, icon: TabIcon }) => {
                                        const active = details === id
                                        return (
                                            <button
                                                key={id}
                                                type="button"
                                                role="tab"
                                                id={`${sheetId}-tab-${id}`}
                                                data-tab={id}
                                                aria-selected={active}
                                                aria-controls={`${sheetId}-panel`}
                                                tabIndex={active ? 0 : -1}
                                                onClick={() => chooseTab(id)}
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors',
                                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                                                    // A real border, not `glass-border` — that token is
                                                    // white-on-white in light mode, which would leave the
                                                    // selected pill with no edge at all.
                                                    active
                                                        ? 'border border-black/[0.08] bg-canvas-elevated text-ink shadow-sm dark:border-white/[0.10]'
                                                        : 'border border-transparent text-ink-muted hover:text-ink',
                                                )}
                                            >
                                                <TabIcon className="h-3.5 w-3.5" aria-hidden />
                                                {label}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>

                        <div
                            role="tabpanel"
                            id={`${sheetId}-panel`}
                            aria-labelledby={canEditDetails ? `${sheetId}-tab-${details}` : undefined}
                            tabIndex={-1}
                            className="p-5"
                        >
                            {details === 'about' || !canEditDetails ? (
                                <ViewBuiltOn view={view} />
                            ) : (
                                <EditDetailsPanel
                                    view={view}
                                    onCancel={closeDetails}
                                    onSaved={handleSaved}
                                    /* The tab above already says "Edit". */
                                    hideHeading
                                    autoFocusName={entry === 'edit'}
                                />
                            )}
                        </div>

                        {/* Who made this and who last touched it — the quiet footer
                            the canvas's old Edit-details dialog carried. It rides on
                            the view this header already fetched, so it costs nothing;
                            it sits OUTSIDE the tabs because it is true of the view
                            either way, and outside the edit gate so it reaches the
                            viewer that dialog never opened for. */}
                        <p className="px-5 pb-5 text-[11px] text-ink-muted leading-relaxed">
                            Created by {view.createdByName ?? 'Unknown'} · {shortDate(view.createdAt)}
                            {view.updatedBy && (
                                <> · Last edited by {view.updatedByName ?? 'Unknown'} · {shortDate(view.updatedAt)}</>
                            )}
                        </p>
                    </aside>
                </div>
            )}

            <ViewActivityDrawer
                viewId={view.id}
                viewName={view.name}
                isOpen={activityOpen}
                onClose={() => setActivityOpen(false)}
            />

            {/* Approve / decline already live in the Share dialog — the badge
                and the audience control are routes to them, not a second
                answering surface. It settles the request on the shared
                ['view', id] query, so the badge clears itself once answered. */}
            <ShareViewDialog
                viewId={view.id}
                viewName={view.name}
                currentVisibility={view.visibility}
                workspaceId={view.workspaceId}
                access={access}
                publishRequest={view.publishRequest}
                isOpen={shareOpen}
                onClose={() => setShareOpen(false)}
            />
        </>
    )
}

/**
 * Input-swap rename field, lifted from the canvas toolbar's title block when
 * that duplicate was removed — the affordance follows the name it renames.
 * Holds its own draft so each session starts from the current name; commits a
 * trimmed, non-empty, CHANGED value on Enter/blur and cancels on Escape, so a
 * stray double-click costs nothing.
 */
function RenameInput({ defaultValue, onCommit, onCancel }: {
    defaultValue: string
    onCommit: (value: string) => void
    onCancel: () => void
}) {
    const [value, setValue] = useState(defaultValue)

    const commit = () => {
        const trimmed = value.trim()
        if (trimmed && trimmed !== defaultValue) onCommit(trimmed)
        else onCancel()
    }

    return (
        <input
            autoFocus
            value={value}
            aria-label="View name"
            onFocus={e => e.target.select()}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter') {
                    e.preventDefault()
                    commit()
                } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                }
                e.stopPropagation()
            }}
            onBlur={commit}
            className="min-w-0 bg-transparent border-b border-accent-lineage outline-none text-[15px] font-bold text-ink leading-tight py-0"
        />
    )
}
