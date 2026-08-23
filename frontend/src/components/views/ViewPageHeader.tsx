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
 * 3. A pending ask to publish the view was invisible ON the view. It surfaced
 *    only in the workspace admin queue and inside the Share dialog, so nobody
 *    looking at the view knew a decision about its audience was outstanding —
 *    including the admin who could answer it.
 *
 * It renders ABOVE the canvas rather than over it. The canvas corners are already
 * spoken for (search trigger top-right at z-30, minimap and controls, transient
 * toasts at top-20), so a floating cluster would have landed on top of something.
 *
 * Both panels are the SHARED components — EditDetailsPanel (lifted out of
 * ExplorerPreviewDrawer, where it was private) and ViewActivityDrawer. One
 * component, two hosts: the Explorer and the canvas cannot drift into showing
 * different edit forms for the same view.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Eye, History, Pencil, X } from 'lucide-react'
import { ViewUsageBadge } from './ViewUsageBadge'
import { cn } from '@/lib/utils'
import { DynamicIcon, resolveViewIcon, viewTypeMeta, viewTypeLabel } from '@/lib/viewUtils'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'
import { EditDetailsPanel } from '@/components/views/EditDetailsPanel'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { timeAgo } from '@/lib/timeAgo'
import { getView, type View } from '@/services/viewApiService'
import { useSchemaStore } from '@/store/schema'

/** Literal class string — Tailwind's JIT scans source text, so these can
 *  never be built by interpolation. Shared by the badge's two forms
 *  (button when the caller can answer, plain chip when they can't). */
const PENDING_BADGE = 'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400 shrink-0'

export function ViewPageHeader({ viewId, workspaceName }: {
    viewId: string
    workspaceName?: string
}) {
    const [activityOpen, setActivityOpen] = useState(false)
    const [detailsOpen, setDetailsOpen] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const queryClient = useQueryClient()
    const updateViewInStore = useSchemaStore(s => s.updateView)

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

    if (!view) return null

    const meta = viewTypeMeta(view.viewType)
    const icon = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })

    // The caller's capability envelope rides on the same response. Without
    // it (older backend), keep the legacy always-visible behavior — the
    // backend still enforces on save.
    const access = view.access ?? null
    const canEditDetails = access ? access.canEdit : true
    const readOnly = access?.dataAccess === 'readonly'

    // A pending ask to publish is state OF THE VIEW, so it belongs on the
    // view — not only in the admin queue and the Share dialog, which is
    // where it used to be hiding. Anyone looking at the view sees that a
    // decision is outstanding; only someone who can answer gets a route in.
    const pendingRequest = view.publishRequest ?? null
    const canAnswerRequest = access?.canAnswerPublishRequest ?? false
    const requestTip = pendingRequest
        ? `Asked by ${pendingRequest.requestedByName ?? 'a workspace member'}`
            + ` ${timeAgo(pendingRequest.requestedAt)}`
            + (canAnswerRequest
                ? ' — open sharing to approve or decline'
                : ' — a workspace admin decides')
        : undefined

    const handleSaved = (updated: View) => {
        setDetailsOpen(false)
        queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, viewId] })
        queryClient.invalidateQueries({ queryKey: ['views'] })
        // The canvas reads its view from the schema store, not React Query — without
        // this a rename would update the header and leave the canvas (and the tab
        // title, which is derived from it) showing the old name until a reload.
        updateViewInStore(viewId, { name: updated.name })
    }

    return (
        <>
            <header className="flex items-center gap-3 px-4 py-2 border-b border-glass-border bg-canvas-elevated/60 backdrop-blur-sm shrink-0">
                <span className={cn(
                    'w-7 h-7 rounded-lg border flex items-center justify-center shrink-0',
                    meta.iconBg,
                )}>
                    <DynamicIcon name={icon} className="w-3.5 h-3.5" />
                </span>

                <div className="min-w-0 flex items-baseline gap-2">
                    <h1 className="text-sm font-bold text-ink truncate">{view.name}</h1>
                    <span className="text-[11px] text-ink-muted truncate hidden sm:inline">
                        {workspaceName ? `${workspaceName} · ` : ''}{viewTypeLabel(view.viewType)}
                    </span>
                    {/* How much this view is actually used, on the view. The
                        platform always knew; it only ever said so on a
                        dashboard the person who built this has no reason to
                        open. Renders nothing while loading or on failure. */}
                    <ViewUsageBadge viewId={viewId} className="hidden md:inline-flex shrink-0" />
                    {readOnly && (
                        <span
                            className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400 shrink-0"
                            title="You can explore everything in this view — expanding, tracing and searching — but nothing can be changed."
                        >
                            <Eye className="w-3 h-3" />
                            {/* "Shared with you" is only true for grant/enterprise
                                reach — a workspace viewer on their own workspace's
                                views just has read-only rights, nothing was shared. */}
                            {access?.accessVia === 'grant' || access?.accessVia === 'enterprise'
                                ? 'Shared with you · read-only'
                                : 'Read-only'}
                        </span>
                    )}
                    {pendingRequest && (canAnswerRequest ? (
                        <button
                            type="button"
                            onClick={() => setShareOpen(true)}
                            title={requestTip}
                            className={cn(PENDING_BADGE, 'hover:bg-amber-500/20 transition-colors')}
                        >
                            <Clock className="w-3 h-3" />
                            Publication requested
                        </button>
                    ) : (
                        <span className={PENDING_BADGE} title={requestTip}>
                            <Clock className="w-3 h-3" />
                            Publication requested
                        </span>
                    ))}
                </div>

                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {canEditDetails && (
                        <button
                            type="button"
                            onClick={() => setDetailsOpen(true)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            title="Rename, describe, tag, or change who can see this view"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Details</span>
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={() => setActivityOpen(true)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        title="Who changed this view, and when its data was last refreshed"
                    >
                        <History className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Activity</span>
                    </button>
                </div>
            </header>

            {/* Details — an inline sheet, not a portal: the canvas below keeps its
                own overlays, and this stays scoped to the page. */}
            {detailsOpen && (
                <div className="absolute inset-0 z-[60] flex justify-end">
                    <button
                        type="button"
                        aria-label="Close details"
                        onClick={() => setDetailsOpen(false)}
                        className="absolute inset-0 bg-black/20 backdrop-blur-[2px]"
                    />
                    <aside className="relative w-full max-w-md h-full overflow-y-auto custom-scrollbar bg-canvas border-l border-glass-border shadow-2xl">
                        <div className="flex items-center justify-between px-5 py-3 border-b border-glass-border">
                            <h2 className="text-sm font-bold text-ink">View details</h2>
                            <button
                                type="button"
                                onClick={() => setDetailsOpen(false)}
                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="p-5">
                            <EditDetailsPanel
                                view={view}
                                onCancel={() => setDetailsOpen(false)}
                                onSaved={handleSaved}
                            />
                        </div>
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
                is a route to them, not a second answering surface. It settles
                the request on the shared ['view', id] query, so the badge
                clears itself once answered. */}
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
