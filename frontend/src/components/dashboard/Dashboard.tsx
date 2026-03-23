import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { useNavigationStore } from '@/store/navigation'
import { DashboardHero, type DashboardSearchResult } from './DashboardHero'
import { InsightCards } from './InsightCards'
import { WorkspaceGrid } from './WorkspaceGrid'
import { ViewGrid } from './ViewGrid'
import { TemplateGrid as BlueprintGrid } from './TemplateGrid'
import { DashboardOnboarding } from './DashboardOnboarding'
import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate, Globe, Database, Eye, BookOpen } from 'lucide-react'
import { MOTION } from '@/lib/motion'

export function Dashboard() {
    const {
        stats,
        dataSourceStats,
        workspaces,
        recentViews,
        templates,
        ontologies,
        dashboardTier,
        isLoadingWorkspaces,
    } = useDashboardData()

    const navigate = useNavigate()
    const totalViewsCount = useSchemaStore(s => s.schema?.views.length || 0)
    const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
    const setActiveView = useSchemaStore(s => s.setActiveView)
    const setActiveTab = useNavigationStore(s => s.setActiveTab)

    // Onboarding state
    const onboardingCompletedSteps = usePreferencesStore(s => s.onboardingCompletedSteps)
    const onboardingDismissedAt = usePreferencesStore(s => s.onboardingDismissedAt)
    const dismissOnboarding = usePreferencesStore(s => s.dismissOnboarding)

    const [searchQuery, setSearchQuery] = useState('')

    const isOnboarding = dashboardTier === 'new' && !onboardingDismissedAt

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
                    },
                })
            }

            // Data sources within each workspace
            ws.dataSources?.forEach(ds => {
                if ((ds.label ?? '').toLowerCase().includes(q)) {
                    results.push({
                        id: `ds-${ds.id}`,
                        label: ds.label ?? ds.id,
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

        // Views
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

        // Templates
        templates.forEach(t => {
            if (t.name.toLowerCase().includes(q)) {
                results.push({
                    id: `tpl-${t.id}`,
                    label: t.name,
                    sublabel: t.description,
                    category: 'Template',
                    icon: LayoutTemplate,
                    onSelect: () => {/* templates don't navigate */ },
                })
            }
        })

        // Semantic Layers (ontologies)
        ontologies.forEach(o => {
            if (o.name.toLowerCase().includes(q)) {
                results.push({
                    id: `sl-${o.id}`,
                    label: o.name,
                    sublabel: o.description ?? `v${o.version ?? 1}`,
                    category: 'Semantic Layer',
                    icon: BookOpen,
                    onSelect: () => { setActiveTab('schema') },
                })
            }
        })

        // Cap at 12 results, stable order
        const ORDER: DashboardSearchResult['category'][] = ['Workspace', 'Data Source', 'View', 'Template', 'Semantic Layer']
        return results
            .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category))
            .slice(0, 12)
    }, [searchQuery, workspaces, recentViews, templates, ontologies,
        setActiveWorkspace, setActiveDataSource, setActiveView, navigate])

    // ── Loading state: show spinner only while workspaces load ─────────────────
    if (isLoadingWorkspaces) {
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

    // ── Onboarding: first-run experience for new users ────────────────────────
    if (isOnboarding) {
        return (
            <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
                <div className="max-w-[1440px] mx-auto pb-28">
                    <DashboardOnboarding
                        completedSteps={onboardingCompletedSteps}
                        onCreateWorkspace={() => setActiveTab('admin')}
                        onBrowseTemplates={() => setActiveTab('schema')}
                        onDismiss={dismissOnboarding}
                    />

                    {/* Still show templates during onboarding — they're relevant */}
                    {templates.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: MOTION.sectionY }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: MOTION.sectionStagger * 2, ...MOTION.sectionEntry }}
                            className="px-4 md:px-0"
                        >
                            <BlueprintGrid
                                title="Starter Templates"
                                subtitle="Pre-built context models to accelerate setup"
                                items={templates}
                                icon={LayoutTemplate}
                            />
                        </motion.div>
                    )}
                </div>
            </div>
        )
    }

    // ── Normal dashboard: tier-aware section ordering ─────────────────────────
    const hasViews = recentViews.length > 0
    const showKPIs = dashboardTier !== 'beginner' || totalViewsCount > 0

    return (
        <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
            <div className="max-w-[1440px] mx-auto pb-28">

                {/* 1. Hero Search */}
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...MOTION.sectionEntry }}>
                    <DashboardHero
                        value={searchQuery}
                        onChange={setSearchQuery}
                        results={searchResults}
                    />
                </motion.div>

                {/* 2. Jump Back In — highest-intent for returning users */}
                {hasViews && (
                    <motion.div
                        initial={{ opacity: 0, y: MOTION.sectionY }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: MOTION.sectionStagger, ...MOTION.sectionEntry }}
                    >
                        <ViewGrid
                            title="Jump Back In"
                            subtitle="Context views scoped to your active workspace"
                            views={recentViews}
                            icon={Monitor}
                            emptyMessage="No views for the current scope. Select a workspace and data source to see its views."
                        />
                    </motion.div>
                )}

                {/* 3. Active Environments */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 2, ...MOTION.sectionEntry }}
                >
                    <WorkspaceGrid workspaces={workspaces} dataSourceStats={dataSourceStats} />
                </motion.div>

                {/* 4. Insight KPI cards — ambient info, below workspaces */}
                {showKPIs && (
                    <motion.div
                        initial={{ opacity: 0, y: MOTION.sectionY }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: MOTION.sectionStagger * 3, ...MOTION.sectionEntry }}
                    >
                        <InsightCards
                            stats={stats}
                            templatesCount={templates.length}
                            viewsCount={totalViewsCount}
                        />
                    </motion.div>
                )}

                {/* 5. Starter Templates — templates only */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 4, ...MOTION.sectionEntry }}
                >
                    <BlueprintGrid
                        title="Starter Templates"
                        subtitle="Pre-built context models to accelerate setup"
                        items={templates}
                        icon={LayoutTemplate}
                    />
                </motion.div>

                {/* 6. Semantic Layers — ontologies only */}
                {ontologies.length > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: MOTION.sectionY }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: MOTION.sectionStagger * 5, ...MOTION.sectionEntry }}
                    >
                        <BlueprintGrid
                            title="Semantic Layers"
                            subtitle="Published semantic schemas powering your data graph"
                            items={ontologies}
                            icon={BookOpen}
                            onBrowseAll={() => setActiveTab('schema')}
                        />
                    </motion.div>
                )}

            </div>
        </div>
    )
}
