import { useCallback } from 'react'
import { useNavigationStore } from '@/store/navigation'
import { useSchemaStore } from '@/store/schema'
import { type ViewConfiguration } from '@/types/schema'
import { motion } from 'framer-motion'
import {
    Eye, ArrowRight, ChevronRight, Clock, Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LAYOUT_ICONS, LAYOUT_COLORS } from './dashboard-constants'

function useOpenView() {
    const setActiveView = useSchemaStore(s => s.setActiveView)
    const setActiveTab = useNavigationStore(s => s.setActiveTab)
    return useCallback((viewId: string) => {
        setActiveView(viewId)
        setActiveTab('explore')
    }, [setActiveView, setActiveTab])
}

export function ViewGrid({ title, subtitle, views, icon: Icon, emptyMessage = 'No items found' }: {
    title: string; subtitle?: string; views: ViewConfiguration[]
    icon: React.ComponentType<{ className?: string }>; emptyMessage?: string
}) {
    const openView = useOpenView()
    const setActiveTab = useNavigationStore(s => s.setActiveTab)
    const activeViewId = useSchemaStore(s => s.activeViewId)

    return (
        <section className="mb-16 px-4 md:px-0">
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <Icon className="w-4 h-4 text-ink-secondary" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                <button onClick={() => setActiveTab('explore')} className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">
                    All views <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {views.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center mb-3">
                        <Icon className="w-6 h-6 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">No views yet</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">{emptyMessage}</p>
                    <button onClick={() => setActiveTab('explore')} className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-business/10 border border-accent-business/20 text-accent-business text-sm font-semibold hover:bg-accent-business/20 transition-colors">
                        <Sparkles className="w-4 h-4" /> Explore canvas
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {views.map((v, i) => {
                        const layoutType = v.layout?.type ?? 'graph'
                        const LayoutIcon = LAYOUT_ICONS[layoutType] ?? Eye
                        const colorCls = LAYOUT_COLORS[layoutType] ?? 'text-ink-secondary bg-black/5 border-glass-border'
                        const isCurrentView = v.id === activeViewId

                        return (
                            <motion.div
                                key={v.id}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.03, duration: 0.2 }}
                                onClick={() => openView(v.id)}
                                className={cn(
                                    'group relative glass-panel rounded-2xl border transition-all cursor-pointer overflow-hidden hover:-translate-y-0.5 hover:shadow-xl flex flex-col min-h-[150px]',
                                    isCurrentView
                                        ? 'border-accent-lineage/50 shadow-lg shadow-accent-lineage/10'
                                        : 'border-glass-border hover:border-accent-lineage/40'
                                )}
                            >
                                {isCurrentView && (
                                    <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-accent-lineage shadow-[0_0_6px] shadow-accent-lineage animate-pulse" />
                                )}
                                <div className="absolute inset-0 bg-gradient-to-br from-accent-lineage/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                                <div className="relative p-5 flex flex-col flex-1 justify-between">
                                    <div>
                                        <div className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider mb-3', colorCls)}>
                                            <LayoutIcon className="w-3 h-3" />
                                            {layoutType}
                                        </div>
                                        <h4 className="font-bold text-base text-ink group-hover:text-accent-lineage transition-colors line-clamp-1 mb-1">{v.name}</h4>
                                        <p className="text-xs text-ink-muted line-clamp-2">{v.description || 'Context view for data exploration'}</p>
                                    </div>
                                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-glass-border/50">
                                        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                            <Clock className="w-3 h-3" />
                                            <span>{isCurrentView ? 'Current view' : 'Active'}</span>
                                        </div>
                                        <div className="flex items-center gap-1 text-[11px] font-semibold text-ink-muted/0 group-hover:text-accent-lineage transition-all">
                                            Open <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )
                    })}
                </div>
            )}
        </section>
    )
}
