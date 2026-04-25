import { useState, useEffect, useMemo } from 'react'
import { useWorkspaces } from './useWorkspaces'
import { useSchemaStore } from '@/store/schema'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import type { ViewConfiguration } from '@/types/schema'

const EMPTY_VIEWS: ViewConfiguration[] = []

export interface DashboardStats {
    totalWorkspaces: number
    totalDataSources: number
    totalEntities: number
    activeConnections: number
}

export interface DataSourceStats {
    nodeCount: number
    edgeCount: number
    entityTypes: string[]
}

export interface TemplateBrief {
    id: string
    name: string
    description?: string
    category?: string
    entityTypesCount?: number
}

export interface OntologyBrief {
    id: string
    name: string
    description?: string
    version?: number
    isPublished?: boolean
    createdAt?: string
}

/** @deprecated Use OntologyBrief */
export type BlueprintBrief = OntologyBrief

export function useDashboardData() {
    const { workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces()
    const views = useSchemaStore(s => s.schema?.views ?? EMPTY_VIEWS)
    const activeScopeKey = useSchemaStore(s => s.activeScopeKey)
    const visibleViews = useMemo(
        () => views.filter(v => !v.scopeKey || v.scopeKey === activeScopeKey),
        [views, activeScopeKey]
    )

    const [stats, setStats] = useState<DashboardStats>({
        totalWorkspaces: 0,
        totalDataSources: 0,
        totalEntities: 0,
        activeConnections: 0
    })

    // Per-datasource node/edge counts: key = "${wsId}/${dsId}"
    const [dataSourceStats, setDataSourceStats] = useState<Record<string, DataSourceStats>>({})

    const [templates, setTemplates] = useState<TemplateBrief[]>([])
    const [ontologies, setOntologies] = useState<OntologyBrief[]>([])

    const [isLoadingTemplates, setIsLoadingTemplates] = useState(false)
    const [isLoadingOntologies, setIsLoadingOntologies] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    // Calculate high level stats whenever workspaces change
    useEffect(() => {
        if (workspaces) {
            let dsCount = 0
            let activeCount = 0

            workspaces.forEach(ws => {
                if (ws.dataSources) {
                    dsCount += ws.dataSources.length
                    ws.dataSources.forEach(() => {
                        activeCount++
                    })
                }
            })

            setStats(prev => ({
                ...prev,
                totalWorkspaces: workspaces.length,
                totalDataSources: dsCount,
                activeConnections: activeCount
            }))
        }
    }, [workspaces])

    // Fetch per-datasource graph stats (node + edge counts)
    useEffect(() => {
        if (!workspaces?.length) return

        const fetchAllStats = async () => {
            const results: Record<string, DataSourceStats> = {}
            let totalEntities = 0

            const fetchPromises = workspaces.flatMap(ws =>
                (ws.dataSources || []).map(async ds => {
                    // Use cached-stats endpoint (DB-only) — no provider dependency.
                    // The endpoint returns the canonical {data, meta} envelope;
                    // ``fetchEnveloped`` unwraps and returns ``null`` on cold
                    // cache (``meta.status === "computing"``) so we render zero
                    // counts only when the row is genuinely missing — same UX
                    // as before, but no longer broken by the envelope wrapper.
                    const url = `/api/v1/admin/workspaces/${ws.id}/datasources/${ds.id}/cached-stats`
                    const data = await fetchEnveloped<{
                        nodeCount?: number
                        edgeCount?: number
                        entityTypeCounts?: Record<string, number>
                    }>(url, { circuitScope: { workspaceId: ws.id, dataSourceId: ds.id } })
                    if (!data) return
                    const nodeCount = data.nodeCount ?? 0
                    const edgeCount = data.edgeCount ?? 0
                    const entityTypes = Object.keys(data.entityTypeCounts ?? {})
                    results[`${ws.id}/${ds.id}`] = { nodeCount, edgeCount, entityTypes }
                    totalEntities += nodeCount
                })
            )

            await Promise.all(fetchPromises)
            setDataSourceStats(results)
            setStats(prev => ({ ...prev, totalEntities }))
        }

        fetchAllStats()
    }, [workspaces])

    // Fetch Templates
    useEffect(() => {
        const fetchTemplates = async () => {
            setIsLoadingTemplates(true)
            try {
                const res = await fetchWithTimeout('/api/v1/admin/context-model-templates')
                if (res.ok) {
                    const data = await res.json()
                    setTemplates(data || [])
                }
            } catch (err) {
                setError(err instanceof Error ? err : new Error('Failed to load templates'))
            } finally {
                setIsLoadingTemplates(false)
            }
        }
        fetchTemplates()
    }, [])

    // Fetch Ontologies
    useEffect(() => {
        const fetchOntologies = async () => {
            setIsLoadingOntologies(true)
            try {
                const res = await fetchWithTimeout('/api/v1/admin/ontologies')
                if (res.ok) {
                    const data = await res.json()
                    setOntologies(data || [])
                }
            } catch (err) {
                setError(err instanceof Error ? err : new Error('Failed to load ontologies'))
            } finally {
                setIsLoadingOntologies(false)
            }
        }
        fetchOntologies()
    }, [])

    // Derive recent and popular views — memoized so downstream effects get stable refs
    const recentViews = useMemo(
        () => visibleViews.filter(v => !v.isDefault).slice(0, 8),
        [visibleViews]
    )
    const popularViews = useMemo(
        () => visibleViews.filter(v => v.isDefault).slice(0, 8),
        [visibleViews]
    )

    // Dashboard tier: determines layout and which sections render
    const dashboardTier = useMemo(() => {
        if (!workspaces || workspaces.length === 0) return 'new' as const
        if (workspaces.length <= 1 && recentViews.length <= 2) return 'beginner' as const
        if (workspaces.length >= 5 || recentViews.length >= 10) return 'power' as const
        return 'active' as const
    }, [workspaces, recentViews.length])

    return {
        stats,
        dataSourceStats,
        workspaces,
        recentViews,
        popularViews,
        templates,
        ontologies,
        dashboardTier,
        /** @deprecated Use ontologies */
        blueprints: ontologies,
        isLoading: isLoadingWorkspaces || isLoadingTemplates || isLoadingOntologies,
        isLoadingWorkspaces,
        isLoadingTemplates,
        isLoadingOntologies,
        error
    }
}
