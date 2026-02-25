import { useDashboardData } from '@/hooks/useDashboardData'
import { useSchemaStore } from '@/store/schema'
import {
    DashboardHero,
    InsightCards,
    WorkspaceGrid,
    ViewGrid,
    BlueprintGrid
} from './DashboardComponents'
import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate } from 'lucide-react'

export function Dashboard() {
    const {
        stats,
        dataSourceStats,
        workspaces,
        recentViews,
        templates,
        blueprints,
        isLoading
    } = useDashboardData()

    const totalViewsCount = useSchemaStore(s => s.schema?.views.length || 0)

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

                {/* 1. Hero Search */}
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
                    <DashboardHero />
                </motion.div>

                {/* 2. Insight KPI cards */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15, duration: 0.5, ease: 'easeOut' }}
                >
                    <InsightCards
                        stats={stats}
                        templatesCount={templates.length}
                        viewsCount={totalViewsCount}
                    />
                </motion.div>

                {/* 3. Active Environments — with real per-datasource stats */}
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
                >
                    <WorkspaceGrid workspaces={workspaces} dataSourceStats={dataSourceStats} />
                </motion.div>

                {/* 4. Jump Back In — Recent Views */}
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.35, duration: 0.5, ease: 'easeOut' }}
                >
                    <ViewGrid
                        title="Jump Back In"
                        subtitle="Your recently accessed context views"
                        views={recentViews}
                        icon={Monitor}
                        emptyMessage="No recent views yet. Start exploring to create some."
                    />
                </motion.div>

                {/* 5. Starter Templates */}
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.45, duration: 0.5, ease: 'easeOut' }}
                >
                    <BlueprintGrid
                        title="Starter Templates"
                        subtitle="Semantic context model blueprints ready to deploy"
                        items={[...templates, ...blueprints]}
                        icon={LayoutTemplate}
                    />
                </motion.div>

            </div>
        </div>
    )
}
