/**
 * The data-source deletion flow — the versioned blast radius, and the thing that is safe.
 *
 * The old dialog listed the semantic views that would break, and stopped there. Everything the
 * version store held went unmentioned: the commits, the colleagues' unpublished drafts, the
 * entities somebody had hand-curated. On a real data source here that is 71 commits, 36 open
 * drafts and 181 curated entities — none of which the user was told about before clicking
 * "Confirm Removal", and none of which come back.
 *
 * Two rules, and the second is the one that makes the first work:
 *
 *   1. NAME THE IRREPLACEABLE THING. Views can be rebuilt. Version rows can be re-imported.
 *      Somebody's half-finished draft cannot, and neither can the afternoon they spent curating
 *      entity names. Those go first in the list, because they are what a person would actually
 *      want to be stopped for.
 *
 *   2. SAY WHAT IS SAFE. A data source is usually pinned to the customer's OWN FalkorDB graph —
 *      `nexus_lineage` — which we did not create and will not delete. If we only ever list
 *      horrors, people learn to click through the dialog, and then it has taught them to ignore
 *      the one that mattered. So the caveat says, in plain words, that their graph data is
 *      staying exactly where it is.
 */
import { useCallback, useState } from 'react'
import {
    workspaceService,
    type WorkspaceDataSourceImpactResponse,
} from '@/services/workspaceService'
import type { ImpactSection } from '@/components/ui/DangerConfirmDialog'

export function impactSections(
    impact: WorkspaceDataSourceImpactResponse | null,
): ImpactSection[] {
    if (!impact) return []
    const v = impact.versioning
    const sections: ImpactSection[] = [
        {
            label: impact.views.length === 1 ? 'View' : 'Views',
            consequence: 'stop working — they read from this source',
            count: impact.views.length,
            items: impact.views,
        },
    ]
    if (!v?.versioned) return sections

    return [
        // Drafts first, deliberately. It is the only line on this list that belongs to somebody
        // who is not in the room, and the owner — not the name — is what says so: drafts are
        // almost all called "Untitled draft".
        {
            label: v.openDrafts.length === 1 ? 'Unpublished draft' : 'Unpublished drafts',
            consequence: 'deleted — this is work nobody has published yet',
            count: v.openDrafts.length,
            items: v.openDrafts.map(d => ({
                id: d.id,
                name: d.owner ? `${d.name} — ${d.owner}` : d.name,
            })),
        },
        {
            label: v.curatedEntities === 1 ? 'Hand-curated entity' : 'Hand-curated entities',
            consequence: 'lose their edits — re-importing the source will not bring them back',
            count: v.curatedEntities,
        },
        {
            label: v.openReviews === 1 ? 'Open review' : 'Open reviews',
            consequence: 'closed without merging',
            count: v.openReviews,
        },
        {
            label: v.commits === 1 ? 'Revision' : 'Revisions',
            consequence: 'erased — the full history of who changed what, and when',
            count: v.commits,
        },
        ...sections,
    ]
}

/**
 * What the delete does NOT do. This is not filler — it is the reason the rest of the dialog gets
 * read. `falkorGraphOwned` is a recorded fact (we own a graph iff we generated its name), never a
 * guess, so we can say this without hedging.
 */
export function deleteCaveat(impact: WorkspaceDataSourceImpactResponse | null): string | undefined {
    const v = impact?.versioning
    if (!v?.versioned) {
        return 'The graph data itself stays in its provider — removing a data source does not delete it.'
    }
    if (!v.falkorGraphOwned && v.falkorGraphName) {
        return `Your graph data is safe: “${v.falkorGraphName}” belongs to your provider, `
            + 'not to us, and nothing in it will be touched. What is deleted is the version '
            + 'history we kept on top of it.'
    }
    // We minted this graph, so the purge really will drop it. Say so, rather than reassuring.
    return 'This also deletes the graph we generated for this source. The version history and '
        + 'the graph both go.'
}

export interface DeletionTarget {
    id: string
    label: string
    impact: WorkspaceDataSourceImpactResponse | null
    loading: boolean
    /** The probe REJECTED. Distinct from "the impact came back empty" — never conflate them. */
    unknown: boolean
}

export function useDataSourceDeletion(wsId: string | undefined, onDeleted: () => void) {
    const [target, setTarget] = useState<DeletionTarget | null>(null)

    const open = useCallback(async (id: string, label: string) => {
        if (!wsId) return
        setTarget({ id, label, impact: null, loading: true, unknown: false })
        try {
            const impact = await workspaceService.getDataSourceImpact(wsId, id)
            setTarget({ id, label, impact, loading: false, unknown: false })
        } catch {
            // A failed probe must never render as "safe to delete". We know less than we did a
            // moment ago; the dialog is told exactly that.
            setTarget({ id, label, impact: null, loading: false, unknown: true })
        }
    }, [wsId])

    const close = useCallback(() => setTarget(null), [])

    const confirm = useCallback(async () => {
        if (!wsId || !target) return
        await workspaceService.removeDataSource(wsId, target.id)
        setTarget(null)
        onDeleted()
    }, [wsId, target, onDeleted])

    return { target, open, close, confirm }
}
