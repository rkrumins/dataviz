import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import {
    DashboardHero,
    InsightCards,
    WorkspaceGrid,
    ViewGrid,
    BlueprintGrid,
    type DashboardSearchResult,
} from './DashboardComponents'
import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate, Globe, Database, Eye, Package } from 'lucide-react'

export function Dashboard() {
    const {
        stats,
        dataSourceStats,
        workspaces,
        recentViews,
        templates,
        ontologies,
        isLoading
    } = useDashboardData()

    const navigate = useNavigate()
    const totalViewsCount = useSchemaStore(s => s.schema?.views.length || 0)
    const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
    const setActiveView = useSchemaStore(s => s.setActiveView)

    const [searchQuery, setSearchQuery] = useState('')

    // ── Compute live search results ────────────────────────────────────────────
    const searchResults = useMemo<DashboardSearchResult[]>(() => {
        const q = searchQuery.trim().toLowerCase()
        if (!q) return []

        const results: DashboardSearchResult[] = []

        // Workspaces
        workspaces.forEach(ws => {
            if (ws.name.toLowerCase().includes(q) || ws.description?.toLowerCase().includes(q)) {
                results.push({
                    id: `ws-${ws.id}`,
                    label: ws.name,
                    sublabel: ws.description ?? `${ws.dataSources?.length ?? 0} data sources`,
                    category: 'Workspace',
                    icon: Globe,
                    onSelect: () => {
                        setActiveWorkspace(ws.id)
                        // Don't navigate — just activate scope, views update below
                    },
                })
            }

            // Data sources within each workspace
            ws.dataSources?.forEach(ds => {
                if ((ds.label ?? ds.graphName ?? '').toLowerCase().includes(q)) {
                    results.push({
                        id: `ds-${ds.id}`,
                        label: ds.label ?? ds.graphName ?? ds.id,
                        sublabel: `Data source in ${ws.name}`,
                        category: 'Data Source',
                        icon: Database,
                        onSelect: () => {
                            setActiveWorkspace(ws.id)
                            setActiveDataSource(ds.id)
                            navigate(`/workspaces/${ws.id}`)
                        },
                    })
                }
            })
        })

        // Views — use recentViews (stable ref from useDashboardData)
        recentViews.forEach(v => {
            if (v.name.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q)) {
                results.push({
                    id: `view-${v.id}`,
                    label: v.name,
                    sublabel: v.description ?? `${v.layout?.type ?? 'graph'} view`,
                    category: 'View',
                    icon: Eye,
                    onSelect: () => {
                        setActiveView(v.id)
                        navigate(`/views/${v.id}`)
                    },
                })
            }
        })

            // Templates & ontologies
            ;[...templates, ...ontologies].forEach(t => {
                if (t.name.toLowerCase().includes(q)) {
                    results.push({
                        id: `tpl-${t.id}`,
                        label: t.name,
                        sublabel: 'description' in t ? (t as { description?: string }).description : undefined,
                        category: 'Template',
                        icon: Package,
                        onSelect: () => {/* templates don't navigate */ },
                    })
                }
            })

        // Cap at 12 results, stable order: Workspace → Data Source → View → Template
        const ORDER: DashboardSearchResult['category'][] = ['Workspace', 'Data Source', 'View', 'Template']
        return results
            .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category))
            .slice(0, 12)
    }, [searchQuery, workspaces, recentViews, templates, ontologies,
        setActiveWorkspace, setActiveDataSource, setActiveView, navigate])

    if (isLoading) {
        return (
            <div className="w-full h-full bg-canvas flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="relative w-12 h-12">
                        <div className="absolute inset-0 rounded-full border-2 border-accent-business/20" />
                        <div className="absolute inset-0 rounded-full border-2 border-accent-business border-t-transparent animate-spin" />
                    </div>
                    <div className="text-center">
                        <div className="text-sm font-semibold text-ink animate-pulse">Loading your workspace</div>
                        <div className="text-xs text-ink-muted mt-1">Fetching environments & views</div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
            <div className="max-w-[1440px] mx-auto pb-28">

                {/* 1. Hero Search — controlled, live results */}
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
                    <DashboardHero
                        value={searchQuery}
                        onChange={setSearchQuery}
                        results={searchResults}
                    />
                </motion.div>

                {/* 2. Insight KPI cards */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.5, ease: 'easeOut' }}
                >
                    <InsightCards
                        stats={stats}
                        templatesCount={templates.length}
                        viewsCount={totalViewsCount}
                    />
                </motion.div>

                {/* 3. Active Environments */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2, duration: 0.5, ease: 'easeOut' }}
                >
                    <WorkspaceGrid workspaces={workspaces} dataSourceStats={dataSourceStats} />
                </motion.div>

                {/* 4. Jump Back In */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3, duration: 0.5, ease: 'easeOut' }}
                >
                    <ViewGrid
                        title="Jump Back In"
                        subtitle="Context views scoped to your active workspace"
                        views={recentViews}
                        icon={Monitor}
                        emptyMessage="No views for the current scope. Select a workspace and data source to see its views."
                    />
                </motion.div>

                {/* 5. Starter Templates */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4, duration: 0.5, ease: 'easeOut' }}
                >
                    <BlueprintGrid
                        title="Starter Templates"
                        subtitle="Semantic context model ontologies ready to deploy"
                        items={[...templates, ...ontologies]}
                        icon={LayoutTemplate}
                    />
                </motion.div>

            </div>
        </div>
    )
}
