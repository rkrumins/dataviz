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
 * pipeline internals belong to an admin persona and live in Ingestion/Admin. The
 * one exception is NeedsAttention: open profiling findings (a source that moved
 * far beyond its usual range, lost a type, or went quiet), shown only to people
 * who can read profiling, because a Dashboard that says "All sources active"
 * while a graph lost half its entities is worse than one that says nothing.
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
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useLayoutTemplates } from '@/hooks/useLayoutTemplates'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { useWorkspaceSummary, useWorkspaceSummaryTrend } from '@/hooks/useWorkspaceSummary'
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
import { DashboardWorkHub } from './DashboardWorkHub'
import { InsightCards } from './InsightCards'
import { NeedsAttention } from './NeedsAttention'
import { WorkspaceGrid } from './WorkspaceGrid'
import { TemplateGrid } from './TemplateGrid'
import { DashboardSemanticLayers } from './DashboardSemanticLayers'
import { DashboardOnboarding } from './DashboardOnboarding'
import { motion } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { PageContainer } from '@/components/layout/PageContainer'

export function Dashboard() {
    useDocumentTitle('Dashboard')
    const {
        workspaces,
        ontologies,
        isLoadingWorkspaces,
    } = useDashboardData()
    const { templates } = useLayoutTemplates()

    // Every number on the page comes from the server's workspace summary — the
    // same figures Administration and the Workspaces page show. The workspace
    // list itself is reloaded on each visit too: it used to load once at sign-in,
    // so added or removed workspaces and sources never showed up here.
    const { summary } = useWorkspaceSummary()
    const { trend } = useWorkspaceSummaryTrend()
    const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)
    useEffect(() => { void loadWorkspaces() }, [loadWorkspaces])

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
                navigate(`/templates/${hit.template.id}`)
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
                navigate('/templates')
                break
            case 'Data Source':
                // No dedicated index — fall through to workspaces list.
                navigate('/workspaces')
                break
        }
        setSearchQuery('')
    }, [navigate, searchResult.query, recordRecentSearch])

    const templateGridProps = {
        templates,
        onUse: (t: LayoutTemplate) => openViewEditor(undefined, { templateId: t.id }),
        onOpen: (t: LayoutTemplate) => navigate(`/templates/${t.id}`),
        onBrowseAll: () => navigate('/templates'),
        onCreate: () => navigate('/templates?new=1'),
    }

    // ── Loading state: a content-shaped skeleton (not a centered spinner) so the
    // shell paints instantly and the layout doesn't jump when data lands. Only on
    // a cold start: the reload on every visit keeps what is already on screen. ──
    if (isLoadingWorkspaces && (workspaces?.length ?? 0) === 0) {
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
                        onBrowseTemplates={() => navigate('/templates')}
                        onDismiss={dismissOnboarding}
                    />

                    {/* Still show templates during onboarding — they're relevant */}
                    {templates.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: MOTION.sectionY }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: MOTION.sectionStagger * 2, ...MOTION.sectionEntry }}
                        >
                            <TemplateGrid {...templateGridProps} />
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

                {/* 2. Your work — ONE section, not three.
                       Unfinished drafts, pinned views and recently visited all
                       answered the same question ("which view do I open?") and
                       overlapped so heavily that ~8 views were drawn ~15 times down
                       the page. Merging them is what lets activity sit directly
                       below the fold instead of three screens down: no cramming
                       required, just less repetition. */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger, ...MOTION.sectionEntry }}
                >
                    <DashboardWorkHub />
                </motion.div>

                {/* 3. Activity — full width, and now the SECOND thing you see.
                       It gets the room it needs (a readable timeline plus its
                       summary) rather than being squeezed into a sidebar. */}
                <motion.div
                    id="dashboard-activity"
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 1.5, ...MOTION.sectionEntry }}
                >
                    <DashboardActivityFeed />
                </motion.div>

                {/* 4. Active environments (the user's business areas) */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 3, ...MOTION.sectionEntry }}
                >
                    <WorkspaceGrid workspaces={workspaces} summary={summary} />
                </motion.div>

                {/* 5. At-a-glance numbers — live values, their 30-day trend, and a
                       sheet with what is behind each */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 4, ...MOTION.sectionEntry }}
                >
                    <InsightCards summary={summary} trend={trend} ontologies={ontologies} />
                    <NeedsAttention />
                </motion.div>

                {/* 6. Layout templates */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 5, ...MOTION.sectionEntry }}
                >
                    <TemplateGrid {...templateGridProps} />
                </motion.div>

                {/* 7. Semantic layers — the REAL ones, from the same cache the
                       Semantic Layers page reads, each card opening its layer.
                       It used to render through the starter-TEMPLATE grid: the cards
                       weren't clickable, and it inherited a category filter no
                       semantic layer has. */}
                <motion.div
                    initial={{ opacity: 0, y: MOTION.sectionY }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: MOTION.sectionStagger * 6, ...MOTION.sectionEntry }}
                >
                    <DashboardSemanticLayers layers={ontologies} />
                </motion.div>

            </PageContainer>
        </div>
    )
}
