import { motion } from 'framer-motion'
import { Monitor, LayoutTemplate, Network, Component } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DashboardStats } from '@/hooks/useDashboardData'
import { CARD_THEMES } from './dashboard-constants'

export function InsightCards({ stats, templatesCount, viewsCount }: {
    stats: DashboardStats; templatesCount: number; viewsCount: number
}) {
    const cards = [
        { label: 'Context Views', sublabel: 'Active perspectives', value: viewsCount, icon: Monitor },
        { label: 'Model Templates', sublabel: 'Ready to deploy', value: templatesCount, icon: LayoutTemplate },
        { label: 'Data Sources', sublabel: 'Connected pipelines', value: stats.totalDataSources, icon: Network },
        { label: 'Tracked Entities', sublabel: 'Nodes in all graphs', value: new Intl.NumberFormat().format(stats.totalEntities), icon: Component },
    ]
    return (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 px-4 md:px-0 mb-14">
            {cards.map((c, i) => {
                const t = CARD_THEMES[i]
                return (
                    <motion.div key={c.label}
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.03, duration: 0.2, ease: 'easeOut' }}
                        className={cn('relative glass-panel rounded-2xl border border-glass-border p-5 cursor-pointer overflow-hidden group hover:-translate-y-1 hover:shadow-xl transition-all duration-300', t.border)}
                    >
                        <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none', t.gradient)} />
                        <div className="relative z-10 flex flex-col h-full">
                            <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center mb-4', t.iconBg)}>
                                <c.icon className="w-4 h-4" />
                            </div>
                            <div className="mt-auto">
                                <div className={cn('text-3xl font-black tracking-tight leading-none mb-1', t.valueCls)}>{c.value}</div>
                                <div className="text-sm font-semibold text-ink">{c.label}</div>
                                <div className="text-xs text-ink-muted mt-0.5">{c.sublabel}</div>
                            </div>
                        </div>
                    </motion.div>
                )
            })}
        </div>
    )
}
