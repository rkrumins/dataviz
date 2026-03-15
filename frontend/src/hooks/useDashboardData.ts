import { useState, useEffect } from 'react'
import { useWorkspaces } from './useWorkspaces'
import { useSchemaStore } from '@/store/schema'

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
    const views = useSchemaStore(s => s.schema?.views || [])
    const activeScopeKey = useSchemaStore(s => s.activeScopeKey)
    const visibleViews = views.filter(v => !v.scopeKey || v.scopeKey === activeScopeKey)

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
                    try {
                        const url = `/api/v1/${ws.id}/graph/stats?dataSourceId=${ds.id}`
                        const res = await fetch(url)
                        if (res.ok) {
                            const data = await res.json()
                            const nodeCount = data.node_count ?? data.nodeCount ?? data.totalNodes ?? 0
                            const edgeCount = data.edge_count ?? data.edgeCount ?? data.totalEdges ?? 0
                            const entityTypes = data.entity_types ?? data.entityTypes ?? []
                            results[`${ws.id}/${ds.id}`] = { nodeCount, edgeCount, entityTypes }
                            totalEntities += nodeCount
                        }
                    } catch {
                        // Silently ignore per-datasource stat failures
                    }
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
                const res = await fetch('/api/v1/admin/context-model-templates')
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
                const res = await fetch('/api/v1/admin/ontologies')
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

    // Derive recent and popular views
    const recentViews = [...(visibleViews || [])]
        .filter(v => !v.isDefault)
        .slice(0, 8)

    const popularViews = [...(visibleViews || [])]
        .filter(v => v.isDefault)
        .slice(0, 8)

    return {
        stats,
        dataSourceStats,
        workspaces,
        recentViews,
        popularViews,
        templates,
        ontologies,
        /** @deprecated Use ontologies */
        blueprints: ontologies,
        isLoading: isLoadingWorkspaces || isLoadingTemplates || isLoadingOntologies,
        error
    }
}
