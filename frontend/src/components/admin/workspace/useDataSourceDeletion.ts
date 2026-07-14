/**
 * The data-source deletion flow — reversible by default, irreversible only when asked.
 *
 * Two things are true at once and the UI has to hold both:
 *
 *   1. DELETING IS DISRUPTIVE NOW. The views stop working, the drafts go out of reach, the
 *      version history disappears from the product. That happens the moment you click, so the
 *      dialog still shows the whole blast radius — 71 revisions, 36 unpublished drafts, 181
 *      hand-curated entities. You should know what you are about to break.
 *
 *   2. DELETING IS NOT DESTRUCTIVE. Nothing is erased. The row is tombstoned, the graph is
 *      tombstoned, and for 30 days one click puts all of it back — including the views, which
 *      keep their link because no DB-level DELETE ever fires to SET NULL it away.
 *
 * So the friction is proportional to the consequence, which is the whole point:
 *
 *   - REMOVE (reversible): full impact, NO type-to-confirm, and an Undo in the toast. Making
 *     someone type a name to confirm something they can undo with one click is theatre, and
 *     theatre is what teaches people to stop reading confirmation dialogs.
 *   - DELETE PERMANENTLY (irreversible): type-to-confirm, and the copy stops hedging.
 */
import { useCallback, useState } from 'react'
import {
    workspaceService,
    type WorkspaceDataSourceImpactResponse,
} from '@/services/workspaceService'
import { useToast } from '@/components/ui/toast'
import type { ImpactSection } from '@/components/ui/DangerConfirmDialog'

export function impactSections(
    impact: WorkspaceDataSourceImpactResponse | null,
    permanent = false,
): ImpactSection[] {
    if (!impact) return []
    const v = impact.versioning
    const views: ImpactSection = {
        label: impact.views.length === 1 ? 'View' : 'Views',
        consequence: 'stop working — they read from this source',
        count: impact.views.length,
        items: impact.views,
    }
    if (!v?.versioned) return [views]

    return [
        // Drafts first: the only line on this list belonging to someone who is not in the room.
        // And identified by OWNER — they are almost all called "Untitled draft", so the name
        // identifies nobody. The count is a statistic; "Priya's draft" is a reason to go and ask.
        {
            label: v.openDrafts.length === 1 ? 'Unpublished draft' : 'Unpublished drafts',
            consequence: permanent
                ? 'deleted — this is work nobody has published yet'
                : 'become unreachable until you restore',
            count: v.openDrafts.length,
            items: v.openDrafts.map(d => ({
                id: d.id,
                name: d.owner ? `${d.name} — ${d.owner}` : d.name,
            })),
        },
        {
            label: v.curatedEntities === 1 ? 'Hand-curated entity' : 'Hand-curated entities',
            consequence: permanent
                ? 'lose their edits — re-importing the source will not bring them back'
                : 'go with it, edits and all',
            count: v.curatedEntities,
        },
        {
            label: v.openReviews === 1 ? 'Open review' : 'Open reviews',
            consequence: permanent ? 'closed without merging' : 'put on hold',
            count: v.openReviews,
        },
        {
            label: v.commits === 1 ? 'Revision' : 'Revisions',
            consequence: permanent
                ? 'erased — the full history of who changed what, and when'
                : 'hidden along with the source',
            count: v.commits,
        },
        views,
    ]
}

/**
 * What the action does NOT do — and, for the reversible one, that it can be taken back.
 *
 * `falkorGraphOwned` is a recorded fact (we own a graph if and only if we generated its name),
 * never a guess, so this can be said without hedging.
 */
export function deleteCaveat(
    impact: WorkspaceDataSourceImpactResponse | null,
    permanent = false,
): string | undefined {
    const v = impact?.versioning
    const days = impact?.restoreWindowDays ?? 30

    if (!permanent) {
        // The single most important sentence in the dialog. It is what makes the list above
        // something to read rather than something to click past.
        return `Nothing is deleted today. You can restore this — and everything above — from `
            + `Recently deleted for ${days} days.`
    }
    if (!v?.versioned) {
        return 'This cannot be undone. The graph data itself stays in its provider — deleting a '
            + 'data source does not delete it.'
    }
    if (!v.falkorGraphOwned && v.falkorGraphName) {
        return `This cannot be undone. Your graph data is safe: “${v.falkorGraphName}” belongs to `
            + 'your provider, not to us, and nothing in it will be touched. What is destroyed is '
            + 'the version history we kept on top of it.'
    }
    // We minted this graph, so the purge really will drop it. Warn; do not reassure.
    return 'This cannot be undone, and it also deletes the graph we generated for this source. '
        + 'The version history and the graph both go.'
}

export interface DeletionTarget {
    id: string
    label: string
    impact: WorkspaceDataSourceImpactResponse | null
    loading: boolean
    /** The probe REJECTED. Distinct from "the impact came back empty" — never conflate them. */
    unknown: boolean
    /** Skipping the trash. Irreversible. */
    permanent: boolean
}

export function useDataSourceDeletion(wsId: string | undefined, onChanged: () => void) {
    const [target, setTarget] = useState<DeletionTarget | null>(null)
    const { showToast } = useToast()

    const restore = useCallback(async (id: string, label: string) => {
        if (!wsId) return
        try {
            await workspaceService.restoreDataSource(wsId, id)
            showToast('success', `${label} restored`)
            onChanged()
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : `Could not restore ${label}`)
        }
    }, [wsId, onChanged, showToast])

    const openFor = useCallback(async (id: string, label: string, permanent: boolean) => {
        if (!wsId) return
        setTarget({ id, label, impact: null, loading: true, unknown: false, permanent })
        try {
            const impact = await workspaceService.getDataSourceImpact(wsId, id)
            setTarget({ id, label, impact, loading: false, unknown: false, permanent })
        } catch {
            // A failed probe must never render as "safe to delete". We know LESS than we did a
            // moment ago; the dialog is told exactly that, and says so in amber.
            setTarget({ id, label, impact: null, loading: false, unknown: true, permanent })
        }
    }, [wsId])

    const open = useCallback(
        (id: string, label: string) => openFor(id, label, false), [openFor])
    const openPermanent = useCallback(
        (id: string, label: string) => openFor(id, label, true), [openFor])

    const close = useCallback(() => setTarget(null), [])

    const confirm = useCallback(async () => {
        if (!wsId || !target) return
        const { id, label, permanent } = target
        await workspaceService.removeDataSource(wsId, id, permanent)
        setTarget(null)
        onChanged()

        if (permanent) {
            showToast('success', `${label} deleted permanently`)
            return
        }
        // THE UNDO. Most undos happen within seconds of the mistake, long before anyone thinks
        // to go looking for a trash can — so the trash comes to them.
        showToast('success', `${label} removed`, {
            label: 'Undo',
            onClick: () => { void restore(id, label) },
        })
    }, [wsId, target, onChanged, showToast, restore])

    return { target, open, openPermanent, close, confirm, restore }
}
