/**
 * Data health, for the Dashboard's Technical view: every data source the reader
 * can read across their team workspaces, said as one of five states, and what
 * changed lately — all from the workspace list the Dashboard already holds. The
 * one thing the list can't say is whether a ready source is behind its latest
 * published changes; the caller asks the cheap projection-health read for that
 * and passes it in.
 *
 * The Playground is left out: its graphs are experiments, nobody's to look after.
 */
import type { WorkspaceResponse } from '@/services/workspaceService'
import { checkPermission, usePermissionClaims, type PermissionClaims } from '@/store/auth'
import { usePersonaMode } from '@/store/persona'
import { useWorkspacesStore } from '@/store/workspaces'

export type SourceHealth = 'failed' | 'behind' | 'processing' | 'not-built' | 'healthy'

export interface HealthSource {
    id: string
    label: string
    workspaceId: string
    workspaceName: string
    status: WorkspaceResponse['dataSources'][number]['aggregationStatus']
    lastAggregatedAt?: string
    createdAt: string
    /** May fix it (rebuild, purge, change settings), not only read it. */
    canManage: boolean
}

/** What projection-health says of a ready source: null is unknown, never healthy. */
export interface Projection {
    projectorCurrent?: boolean | null
    projectionCommitsBehind?: number | null
}

/** The sources whose health the reader may read, in their team workspaces. */
export function readableSources(workspaces: readonly WorkspaceResponse[], claims: PermissionClaims): HealthSource[] {
    return workspaces
        .filter(ws => ws.kind !== 'playground' && checkPermission(claims, 'workspace:datasource:read', ws.id))
        .flatMap(ws => {
            const canManage = checkPermission(claims, 'workspace:datasource:manage', ws.id)
            return (ws.dataSources ?? []).filter(ds => ds.isActive !== false).map(ds => ({
                id: ds.id,
                label: ds.label || ds.graphName || 'Untitled source',
                workspaceId: ws.id,
                workspaceName: ws.name,
                status: ds.aggregationStatus,
                lastAggregatedAt: ds.lastAggregatedAt,
                createdAt: ds.createdAt,
                canManage,
            }))
        })
}

/** Is there a data source the reader may read: any data health to show them? */
export function useHasDataHealth(): boolean {
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore(s => s.workspaces)
    return readableSources(workspaces, claims).length > 0
}

/** The Technical view leads with data health — for someone with a data source to read. */
export function useLeadsWithDataHealth(): boolean {
    const technical = usePersonaMode() === 'technical'
    const hasData = useHasDataHealth()
    return technical && hasData
}

export function healthOf(source: Pick<HealthSource, 'status'>, projection?: Projection | null): SourceHealth {
    switch (source.status) {
        case 'failed': return 'failed'
        case 'running':
        case 'pending': return 'processing'
        case 'none': return 'not-built'
        default: return projection?.projectorCurrent === false ? 'behind' : 'healthy'
    }
}

export interface RatedSource extends HealthSource {
    health: SourceHealth
    /** Published changes not yet in its connections (behind only). */
    behindBy?: number | null
}

const ATTENTION_ORDER: SourceHealth[] = ['failed', 'behind', 'not-built']

export interface DataHealthSummary {
    counts: Record<SourceHealth, number>
    /** Failed, then behind, then never built — the order to look at them in. */
    attention: RatedSource[]
    processing: RatedSource[]
    workspaces: number
}

export function summarizeDataHealth(sources: readonly RatedSource[]): DataHealthSummary {
    const counts: Record<SourceHealth, number> = { failed: 0, behind: 0, processing: 0, 'not-built': 0, healthy: 0 }
    for (const s of sources) counts[s.health] += 1
    const attention = sources
        .filter(s => ATTENTION_ORDER.includes(s.health))
        .sort((a, b) => ATTENTION_ORDER.indexOf(a.health) - ATTENTION_ORDER.indexOf(b.health) || a.label.localeCompare(b.label))
    return {
        counts,
        attention,
        processing: sources.filter(s => s.health === 'processing'),
        workspaces: new Set(sources.map(s => s.workspaceId)).size,
    }
}

export interface DataChange {
    key: string
    kind: 'rebuilt' | 'added'
    at: string
    source: RatedSource
}

/** The latest that happened to the reader's sources: connections rebuilt, sources added. */
export function recentDataChanges(sources: readonly RatedSource[], limit = 5): DataChange[] {
    const changes: DataChange[] = []
    for (const s of sources) {
        if (s.lastAggregatedAt) changes.push({ key: `${s.id}:rebuilt`, kind: 'rebuilt', at: s.lastAggregatedAt, source: s })
        if (s.createdAt) changes.push({ key: `${s.id}:added`, kind: 'added', at: s.createdAt, source: s })
    }
    return changes
        .filter(c => !Number.isNaN(Date.parse(c.at)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, limit)
}
