/**
 * How well each template fits one workspace's data — the library's "Fit for"
 * rings and its "Best match" sort. The same matching the wizard does when a
 * template is applied (`fitTemplate`), against that workspace's primary source.
 */
import { useMemo } from 'react'
import { useWorkspaceEntityTypes } from '@/hooks/useWorkspaceEntityTypes'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { checkPermission, usePermissionClaims } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import { fitTemplate } from './templateFit'

export interface TemplateFitScore {
    matched: number
    typed: number
}

/** The workspaces whose data the caller can read — what a template can be matched against. */
export function useFitWorkspaces(): WorkspaceResponse[] {
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore(s => s.workspaces)
    return useMemo(
        () => workspaces.filter(ws => ws.dataSources.length > 0 && checkPermission(claims, 'workspace:datasource:read', ws.id)),
        [workspaces, claims],
    )
}

/** The source a workspace's data is read from for matching: its primary. */
export function primarySource(workspace: WorkspaceResponse) {
    return workspace.dataSources.find(d => d.isPrimary) ?? workspace.dataSources[0]
}

export function useTemplateFits(templates: readonly LayoutTemplate[], workspace: WorkspaceResponse | null) {
    const source = workspace ? primarySource(workspace) : undefined
    const { types, isLoading } = useWorkspaceEntityTypes(workspace?.id, source?.id)
    const fits = useMemo(() => {
        if (!types) return null
        const out = new Map<string, TemplateFitScore>()
        for (const t of templates) {
            const fit = fitTemplate(t.layers, types)
            out.set(t.id, { matched: fit.matchedLayers, typed: fit.typedLayers })
        }
        return out
    }, [templates, types])
    return { fits, isLoading }
}

/** Share of a template's typed layers that match. One whose layers name no
 *  types matches nothing in particular: it ranks with the poorest fits. */
export function fitShare(score: TemplateFitScore | undefined): number {
    return score && score.typed > 0 ? score.matched / score.typed : 0
}
