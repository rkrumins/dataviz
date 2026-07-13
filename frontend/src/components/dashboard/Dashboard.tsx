/**
 * Dashboard — the home page for the person who uses this day to day: someone who
 * builds views, browses existing ones, and works across a few business areas.
 *
 * It answers, in order:
 *   1. "Where do I resume?"        → real recents (server-side per-user visits)
 *   2. "What has my team done?"    → DashboardActivityFeed, scoped to the
 *                                     workspaces this user is part of
 *   3. "Where do I go next?"       → workspaces, views, templates, semantic layers
 *
 * Deliberately NOT an operator console: provider health, broken/stale sweeps and
 * pipeline internals belong to an admin persona and live in Ingestion/Admin.
 *
 * Everything is now wired to real endpoints. This page previously shipped
 * several placeholders that LOOKED like data:
 *   • "Jump Back In" was `views.filter(v => !v.isDefault).slice(0, 8)` — the first
 *     8 non-default views from a client store, with no relation to what the user
 *     had actually visited. It now uses real per-user visit history.
 *   • `popularViews` was `views.filter(v => v.isDefault)`, and `activeConnections`
 *     counted every data source unconditionally (so it always equalled
 *     totalDataSources). Both were fake AND never rendered — removed from
 *     useDashboardData.
 *   • The KPI cards were `cursor-pointer` with no onClick, and the view count came
 *     from a client store rather than the authoritative catalog stat.
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useViewStats } from '@/hooks/useViewStats'
import { useGlobalSearch, type SearchHit, type SearchCategory } from '@/hooks/useGlobalSearch'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { useSchemaStore } from '@/store/schema'
import { useAuthStore } from '@/store/auth'
import { useMyActivityFeed, MY_FEED_LIMIT } from '@/hooks/useViewActivity'
import { useRecentViews } from '@/hooks/useRecentViews'
import { useViewEditorModal } from '@/components/layout/AppLayout'
import { salutationFor, initialsOf, whatsNewLine, HeroActions } from './dashboardWelcome'
import { useWorkspacesStore } from '@/store/workspaces'
import { usePreferencesStore } from '@/store/preferences'
import { DashboardHero } from './DashboardHero'
import { DashboardSkeleton } from './DashboardSkeleton'
import { DashboardActivityFeed } from './DashboardActivityFeed'
import { InsightCards } from './InsightCards'
import { WorkspaceGrid } from './WorkspaceGrid'
import { TemplateGrid as BlueprintGrid } from './TemplateGrid'
import { DashboardOnboarding } from './DashboardOnboarding'
// "Jump back in" IS the Explorer's recents strip — one component, one shape, one
// icon/theme resolution. A second implementation is how the two would drift.
import { ExplorerRecentStrip } from '@/components/explorer/ExplorerRecentStrip'
import { motion } from 'framer-motion'
import { LayoutTemplate, BookOpen } from 'lucide-react'
import { MOTION } from '@/lib/motion'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { PageContainer } from '@/components/layout/PageContainer'

const EMPTY_STATS_PARAMS = {}

export function Dashboard() {
    useDocumentTitle('Dashboard')
    const {
        stats,
        dataSourceStats,
        workspaces,
        templates,
        ontologies,
        isLoadingWorkspaces,
    } = useDashboardData()

    // Authoritative catalog counts (no filters → the whole catalog).
    const { stats: viewStats } = useViewStats(EMPTY_STATS_PARAMS)

    const navigate = useNavigate()
    const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
    const setActiveView = useSchemaStore(s => s.setActiveView)

    // Onboarding state
    const onboardingCompletedSteps = usePreferencesStore(s => s.onboardingCompletedSteps)
    const onboardingDismissedAt = usePreferencesStore(s => s.onboardingDismissedAt)
    const dismissOnboarding = usePreferencesStore(s => s.dismissOnboarding)

    // Greeting + "what's new" + the CTA row. useMyActivityFeed shares its query
    // key with DashboardActivityFeed, so this reuses that cache rather than
    // firing a second request.
    const user = useAuthStore(s => s.user)
    const { data: feed } = useMyActivityFeed(MY_FEED_LIMIT)
    const { recent } = useRecentViews()
    const { openViewEditor } = useViewEditorModal()

    const greeting = user
        ? {
            salutation: salutationFor(new Date().getHours()),
            name: user.firstName || undefined,
            initials: initialsOf(user.firstName, user.lastName),
        }
        : undefined
    const statusLine = whatsNewLine(feed ?? [], MY_FEED_LIMIT)
    const resumeTarget = recent?.[0]

    const [searchQuery, setSearchQuery] = useState('')
    const searchResult = useGlobalSearch(searchQuery)
    const { recents: recentSearches, record: recordRecentSearch, remove: removeRecentSearch, clear: clearRecentSearches } = useRecentSearches()

    // A brand-new instance = no workspaces. (The old `dashboardTier` heuristic
    // keyed off the fake recentViews count, so it decided layout from noise.)
    const isOnboarding = (workspaces?.length ?? 0) === 0 && !onboardingDismissedAt

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
                // Explorer reads its search from ?q= — this was sending ?search=,
                // so "show all views" landed on an UNFILTERED Explorer.
                navigate(`/explorer?q=${encodeURIComponent(searchResult.query)}`)
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
                <PageContainer className="pb-28">
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
                </PageContainer>
            </div>
        )
    }

    return (
        <div className="w-full h-full bg-canvas overflow-y-auto custom-scrollbar">
            <PageContainer className="pb-28">

                {/* 1. Hero search */}
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
                        greeting={greeting}
                        statusLine={statusLine}
                        onStatusClick={() => {
                            document.getElementById('dashboard-activity')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                        actions={
                            <HeroActions
                                onCreateView={() => openViewEditor()}
                                onResume={resumeTarget ? () => navigate(`/views/${resumeTarget.viewId}`) : undefined}
                                resumeLabel={resumeTarget?.viewName}
                                onBrowse={() => navigate('/explorer')}
                            />
                        }
                    />
                </motion.div>

                {/* 2. Jump back in — REAL per-user visit history */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger, ...MOTION.sectionEntry }}
                >
                    <ExplorerRecentStrip
                        title="Jump back in"
                        subtitle="Views you visited recently"
                    />
                </motion.div>

                {/* 3. What the team has been doing, in the user's workspaces */}
                <motion.div
                    id="dashboard-activity"
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 2, ...MOTION.sectionEntry }}
                >
                    <DashboardActivityFeed />
                </motion.div>

                {/* 4. Active environments (the user's business areas) */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 3, ...MOTION.sectionEntry }}
                >
                    <WorkspaceGrid workspaces={workspaces} dataSourceStats={dataSourceStats} />
                </motion.div>

                {/* 5. At-a-glance numbers — live values, each a click-through */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 4, ...MOTION.sectionEntry }}
                >
                    <InsightCards
                        stats={stats}
                        viewsCount={viewStats.total}
                        semanticLayersCount={ontologies.length}
                    />
                </motion.div>

                {/* 6. Starter templates */}
                <motion.div
                    id="dashboard-templates"
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 5, ...MOTION.sectionEntry }}
                >
                    <BlueprintGrid
                        title="Starter Templates"
                        subtitle="Pre-built context models to accelerate setup"
                        items={templates}
                        icon={LayoutTemplate}
                    />
                </motion.div>

                {/* 7. Semantic layers — the shared business meaning of the data */}
                {ontologies.length > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: MOTION.sectionY }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: MOTION.sectionStagger * 6, ...MOTION.sectionEntry }}
                    >
                        <BlueprintGrid
                            title="Semantic Layers"
                            subtitle="The shared business meaning behind your data"
                            items={ontologies}
                            icon={BookOpen}
                            onBrowseAll={() => navigate('/schema')}
                        />
                    </motion.div>
                )}

            </PageContainer>
        </div>
    )
}
