/**
 * OverviewViewGrid — views on the workspace's front page, in the layout the
 * reader chose:
 *
 *   * **Compact** — one-line tiles that open the view, for getting back to work fast;
 *   * **Cards** — the Explorer's card in the Explorer's grid;
 *   * **List** — the Explorer's rows under its column headers, sortable in place.
 *
 * Cards and rows answer the way they do in the Explorer: a click previews the view
 * in the Explorer's drawer, the heart favourites it, the link button copies its
 * address, Manage sharing opens the Share dialog and the "?" chip opens its questions.
 */
import { useContext, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { favouriteView, unfavouriteView, type View } from '@/services/viewApiService'
import type { SortOption } from '@/hooks/useExplorerViews'
import { useViewUsage } from '@/hooks/useContentInsights'
import { useSubjectCounts } from '@/features/discussions/useDiscussions'
import { useCopyViewLink } from '@/lib/viewShareLink'
import { viewTypeLabel } from '@/lib/viewUtils'
import { compact } from '@/lib/formatMetric'
import { invalidateOtherViewLists } from '@/features/view-filters/invalidate'
import { useAppNotifications } from '@/components/ui/notifications'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '@/components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '@/components/explorer/ExplorerListHeader'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { ViewTile } from './ViewTile'
import type { OverviewLayout } from './overviewLayout'

/** Two across, so a shelf of four fills its rows at every width. */
const GRID = 'grid items-start grid-cols-1 sm:grid-cols-2 gap-4'
const COMPACT_GRID = 'grid gap-2.5 sm:grid-cols-2'

/** A shelf keeps its own order (most recent, most opened…) until a column is chosen;
 *  this sort marks no column. */
const SHELF_ORDER: SortOption = 'most-opened'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const changedAt = (v: View) => Math.max(Date.parse(v.updatedAt ?? '') || 0, Date.parse(v.dataUpdatedAt ?? '') || 0)

/** The few views on a shelf, sorted by a list-header click. */
function sortShelf(views: View[], sort: SortOption): View[] {
    const by = (key: (v: View) => string | number, dir: 1 | -1) =>
        [...views].sort((a, b) => {
            const x = key(a), y = key(b)
            return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
        })
    switch (sort) {
        case 'az': return by(v => v.name, 1)
        case 'za': return by(v => v.name, -1)
        case 'type-az': return by(v => viewTypeLabel(v.viewType), 1)
        case 'type-za': return by(v => viewTypeLabel(v.viewType), -1)
        case 'owner-az': return by(v => v.createdByName ?? v.createdBy ?? '', 1)
        case 'owner-za': return by(v => v.createdByName ?? v.createdBy ?? '', -1)
        case 'likes-asc': return by(v => v.favouriteCount ?? 0, 1)
        case 'popular': return by(v => v.favouriteCount ?? 0, -1)
        case 'modified-asc': return by(changedAt, 1)
        case 'recently-modified': return by(changedAt, -1)
        default: return views
    }
}

/** "120 opens · 9 people", or that nobody opened it lately. */
function usedLine(u: { opens: number; uniqueViewers: number } | undefined): string {
    return u && u.opens > 0 ? `${compact(u.opens)} opens · ${plural(u.uniqueViewers, 'person', 'people')}` : 'Not opened lately'
}

export function OverviewViewGrid({ wsId, views, layout = 'cards', meta }: {
    wsId: string
    views: View[]
    layout?: OverviewLayout
    /** Compact tiles' line of context ("Opened 2h ago"); by default, how much it is used. */
    meta?: (view: View) => string | undefined
}) {
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()
    const copyLink = useCopyViewLink()
    const viewEditor = useContext(ViewEditorContext)
    const usage = useViewUsage(views.map(v => v.id)).data
    // Cards and rows carry their questions; a compact tile is one link, so it asks for none.
    const questions = useSubjectCounts('view', layout === 'compact' ? [] : views.map(v => v.id))

    // A favourite shows at once; the lists catch up when they are read again.
    const [favourite, setFavourite] = useState<Record<string, boolean>>({})
    const [preview, setPreview] = useState<{ view: View; editing: boolean } | null>(null)
    const [sharing, setSharing] = useState<View | null>(null)
    const [sort, setSort] = useState<SortOption>(SHELF_ORDER)

    const shown = useMemo(() => views.map(v => {
        if (!(v.id in favourite) || favourite[v.id] === v.isFavourited) return v
        const on = favourite[v.id]
        return { ...v, isFavourited: on, favouriteCount: Math.max(0, (v.favouriteCount ?? 0) + (on ? 1 : -1)) }
    }), [views, favourite])

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ['workspace-detail-phase2', wsId] })
        void queryClient.invalidateQueries({ queryKey: ['workspace-overview'] })
        invalidateOtherViewLists(queryClient)
    }

    const toggleFavourite = async (v: View) => {
        const on = !v.isFavourited
        setFavourite(f => ({ ...f, [v.id]: on }))
        try {
            await (on ? favouriteView(v.id) : unfavouriteView(v.id))
            refresh()
        } catch {
            setFavourite(f => ({ ...f, [v.id]: !on }))
            notify('error', on ? 'Couldn’t add it to your favourites.' : 'Couldn’t remove it from your favourites.')
        }
    }

    const actions = (v: View) => ({
        view: v,
        usage: usage?.[v.id],
        questions: questions[v.id],
        hideWorkspaceInScope: true,
        onToggleFavourite: () => void toggleFavourite(v),
        onShare: () => void copyLink(v.id),
        onPreview: () => setPreview({ view: v, editing: false }),
        onEdit: () => setPreview({ view: v, editing: true }),
        onEditLayout: viewEditor ? () => viewEditor.openViewEditor(v.id) : undefined,
    })

    return (
        <>
            {layout === 'compact' && (
                <div className={COMPACT_GRID}>
                    {shown.map(v => (
                        <ViewTile key={v.id} view={{ ...v, favourite: v.isFavourited }} meta={meta?.(v) ?? usedLine(usage?.[v.id])} />
                    ))}
                </div>
            )}
            {layout === 'cards' && (
                <div className={GRID}>
                    {shown.map(v => (
                        <ExplorerViewCard key={v.id} {...actions(v)} onManageSharing={() => setSharing(v)} />
                    ))}
                </div>
            )}
            {layout === 'list' && (
                // The Explorer's columns need their width: a narrow screen scrolls the list sideways.
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-x-auto custom-scrollbar">
                    <div className="min-w-[760px]">
                        <ExplorerListHeader sort={sort} onSortChange={setSort} withCheckbox={false} />
                        <div className="divide-y divide-glass-border/50">
                            {sortShelf(shown, sort).map(v => <ExplorerListRow key={v.id} {...actions(v)} />)}
                        </div>
                    </div>
                </div>
            )}

            <ExplorerPreviewDrawer
                view={preview?.view ?? null}
                isOpen={!!preview}
                initialEditMode={preview?.editing}
                onClose={() => setPreview(null)}
                onShare={() => { if (preview) setSharing(preview.view) }}
                onEdit={viewEditor && preview ? () => { const id = preview.view.id; setPreview(null); viewEditor.openViewEditor(id) } : undefined}
                onSaved={updated => {
                    setPreview(p => p && { ...p, view: { ...p.view, ...updated } })
                    refresh()
                }}
            />
            {sharing && (
                <ShareViewDialog
                    viewId={sharing.id}
                    viewName={sharing.name}
                    currentVisibility={sharing.visibility}
                    workspaceId={sharing.workspaceId || wsId}
                    isOpen
                    onClose={() => { setSharing(null); refresh() }}
                />
            )}
        </>
    )
}
