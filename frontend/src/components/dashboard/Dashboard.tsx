import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useGlobalSearch, type SearchHit, type SearchCategory } from '@/hooks/useGlobalSearch'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { DashboardHero } from './DashboardHero'
import { DashboardSkeleton } from './DashboardSkeleton'
import { InsightCards } from './InsightCards'
import { WorkspaceGrid } from './WorkspaceGrid'
import { ViewGrid } from './ViewGrid'
import { TemplateGrid as BlueprintGrid } from './TemplateGrid'
import { DashboardOnboarding } from './DashboardOnboarding'
import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate, BookOpen } from 'lucide-react'
import { MOTION } from '@/lib/motion'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

export function Dashboard() {
    useDocumentTitle('Dashboard')
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

    // Onboarding state
    const onboardingCompletedSteps = usePreferencesStore(s => s.onboardingCompletedSteps)
    const onboardingDismissedAt = usePreferencesStore(s => s.onboardingDismissedAt)
    const dismissOnboarding = usePreferencesStore(s => s.dismissOnboarding)

    const [searchQuery, setSearchQuery] = useState('')
    const searchResult = useGlobalSearch(searchQuery)
    const { recents: recentSearches, record: recordRecentSearch, remove: removeRecentSearch, clear: clearRecentSearches } = useRecentSearches()

    const isOnboarding = dashboardTier === 'new' && !onboardingDismissedAt

    const handleSelectHit = useCallback((hit: SearchHit) => {
        if (searchQuery.trim()) recordRecentSearch(searchQuery)
        switch (hit.category) {
            case 'Workspace':
                setActiveWorkspace(hit.workspace.id)
                navigate(`/workspaces/${hit.workspace.id}`)
                break
            case 'Data Source':
                setActiveWorkspace(hit.workspace.id)
                setActiveDataSource(hit.dataSource.id)
                navigate(`/workspaces/${hit.workspace.id}`)
                break
            case 'View':
                setActiveView(hit.view.id)
                navigate(`/views/${hit.view.id}`)
                break
            case 'Template':
                // Templates have no dedicated detail route — scroll to the
                // dashboard's templates section so the user sees the matching card.
                requestAnimationFrame(() => {
                    document.getElementById('dashboard-templates')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                })
                break
            case 'Semantic Layer':
                navigate(`/schema/${hit.ontology.id}`)
                break
        }
        setSearchQuery('')
    }, [searchQuery, recordRecentSearch, setActiveWorkspace, setActiveDataSource, setActiveView, navigate])

    const handleShowAll = useCallback((category: SearchCategory) => {
        if (searchResult.query) recordRecentSearch(searchResult.query)
        switch (category) {
            case 'View':
                navigate(`/explorer?search=${encodeURIComponent(searchResult.query)}`)
                break
            case 'Workspace':
                navigate('/workspaces')
                break
            case 'Semantic Layer':
                navigate('/schema')
                break
            case 'Template':
                requestAnimationFrame(() => {
                    document.getElementById('dashboard-templates')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                })
                break
            case 'Data Source':
                // No dedicated index — fall through to workspaces list.
                navigate('/workspaces')
                break
        }
        setSearchQuery('')
    }, [navigate, searchResult.query, recordRecentSearch])

    // ── Loading state: a content-shaped skeleton (not a centered spinner) so the
    // shell paints instantly and the layout doesn't jump when data lands. ───────
    if (isLoadingWorkspaces) {
        return <DashboardSkeleton />
    }

    // ── Onboarding: first-run experience for new users ────────────────────────
    if (isOnboarding) {
        return (
            <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
                <div className="max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12 pb-28">
                    <DashboardOnboarding
                        completedSteps={onboardingCompletedSteps}
                        onCreateWorkspace={() => navigate('/workspaces')}
                        onBrowseTemplates={() => navigate('/schema')}
                        onDismiss={dismissOnboarding}
                    />

                    {/* Still show templates during onboarding — they're relevant */}
                    {templates.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: MOTION.sectionY }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: MOTION.sectionStagger * 2, ...MOTION.sectionEntry }}
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
            <div className="max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12 pb-28">

                {/* 1. Hero Search */}
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...MOTION.sectionEntry }}>
                    <DashboardHero
                        value={searchQuery}
                        onChange={setSearchQuery}
                        result={searchResult}
                        onSelectHit={handleSelectHit}
                        onShowAll={handleShowAll}
                        recentSearches={recentSearches}
                        onRemoveRecentSearch={removeRecentSearch}
                        onClearRecentSearches={clearRecentSearches}
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
                    id="dashboard-templates"
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
                            onBrowseAll={() => navigate('/schema')}
                        />
                    </motion.div>
                )}

            </div>
        </div>
    )
}
