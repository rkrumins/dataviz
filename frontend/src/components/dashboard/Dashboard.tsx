import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useGlobalSearch, type SearchHit, type SearchCategory } from '@/hooks/useGlobalSearch'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { useNavigationStore } from '@/store/navigation'
import { DashboardHero } from './DashboardHero'
import { InsightCards } from './InsightCards'
import { WorkspaceGrid } from './WorkspaceGrid'
import { ViewGrid } from './ViewGrid'
import { TemplateGrid as BlueprintGrid } from './TemplateGrid'
import { DashboardOnboarding } from './DashboardOnboarding'
import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate, BookOpen } from 'lucide-react'
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
                <div className="px-6 md:px-10 lg:px-12 pb-28">
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
                            onBrowseAll={() => setActiveTab('schema')}
                        />
                    </motion.div>
                )}

            </div>
        </div>
    )
}
