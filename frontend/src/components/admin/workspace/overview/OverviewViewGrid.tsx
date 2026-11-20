/**
 * OverviewViewGrid — views on the workspace's front page, shown the way the
 * Explorer shows them.
 *
 * The Overview used to draw its own compact tiles, so the same view looked one
 * way here and another in the Explorer and on the Views tab. This renders the
 * Explorer's card in the Explorer's grid, and answers it the same way: a click
 * previews the view in the Explorer's drawer, the heart favourites it, the link
 * button copies its address and Manage sharing opens the Share dialog.
 */
import { useContext, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { favouriteView, unfavouriteView, type View } from '@/services/viewApiService'
import { useViewUsage } from '@/hooks/useContentInsights'
import { useCopyViewLink } from '@/lib/viewShareLink'
import { invalidateOtherViewLists } from '@/features/view-filters/invalidate'
import { useAppNotifications } from '@/components/ui/notifications'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { ExplorerViewCard } from '@/components/explorer/ExplorerViewCard'
import { ExplorerPreviewDrawer } from '@/components/explorer/ExplorerPreviewDrawer'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'

/** The Explorer's grid, sized for the Overview's main column: two across, so a shelf of four
 *  fills its rows at every width. */
const GRID = 'grid items-start grid-cols-1 sm:grid-cols-2 gap-4'

export function OverviewViewGrid({ wsId, views }: { wsId: string; views: View[] }) {
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()
    const copyLink = useCopyViewLink()
    const viewEditor = useContext(ViewEditorContext)
    const usage = useViewUsage(views.map(v => v.id)).data

    // A favourite shows at once; the lists catch up when they are read again.
    const [favourite, setFavourite] = useState<Record<string, boolean>>({})
    const [preview, setPreview] = useState<{ view: View; editing: boolean } | null>(null)
    const [sharing, setSharing] = useState<View | null>(null)

    const shown = views.map(v => {
        if (!(v.id in favourite) || favourite[v.id] === v.isFavourited) return v
        const on = favourite[v.id]
        return { ...v, isFavourited: on, favouriteCount: Math.max(0, (v.favouriteCount ?? 0) + (on ? 1 : -1)) }
    })

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

    return (
        <>
            <div className={GRID}>
                {shown.map(v => (
                    <ExplorerViewCard
                        key={v.id}
                        view={v}
                        usage={usage?.[v.id]}
                        hideWorkspaceInScope
                        onToggleFavourite={() => void toggleFavourite(v)}
                        onShare={() => void copyLink(v.id)}
                        onManageSharing={() => setSharing(v)}
                        onPreview={() => setPreview({ view: v, editing: false })}
                        onEdit={() => setPreview({ view: v, editing: true })}
                        onEditLayout={viewEditor ? () => viewEditor.openViewEditor(v.id) : undefined}
                    />
                ))}
            </div>

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
                    workspaceId={wsId}
                    isOpen
                    onClose={() => { setSharing(null); refresh() }}
                />
            )}
        </>
    )
}
