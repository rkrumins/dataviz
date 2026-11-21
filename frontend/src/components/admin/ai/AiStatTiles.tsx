/**
 * The orientation row of Administration → AI, in the shape of SSO's stat
 * tiles: each tile counts something an administrator would otherwise open a
 * tab to learn, and opens that tab.
 */
import { motion } from 'framer-motion'
import { Database, MessageSquareText, Plug, ThumbsDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AiStats {
    connections: number | null
    questions: number | null
    unhelpful: number | null
    collectionsReady: number | null
}

export type AiTab = 'connections' | 'assistant' | 'knowledge' | 'vocabulary' | 'usage'

const TILES: {
    key: keyof AiStats
    label: string
    icon: LucideIcon
    gradient: string
    accent: string
    iconBg: string
    mutedWhenZero?: boolean
    tab: AiTab
    cta: string
}[] = [
    {
        key: 'connections', label: 'Connections on', icon: Plug, tab: 'connections', cta: 'Open connections',
        gradient: 'from-emerald-500/20 to-emerald-500/0',
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    },
    {
        key: 'questions', label: 'Questions (30 days)', icon: MessageSquareText, tab: 'usage', cta: 'Open usage',
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        accent: 'text-indigo-600 dark:text-indigo-400',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    },
    {
        key: 'unhelpful', label: 'Marked unhelpful (30 days)', icon: ThumbsDown, tab: 'usage', cta: 'Open usage',
        gradient: 'from-red-500/20 to-red-500/0',
        accent: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-500/10 text-red-500 border-red-500/20',
        mutedWhenZero: true,
    },
    {
        key: 'collectionsReady', label: 'Knowledge collections ready', icon: Database, tab: 'knowledge', cta: 'Open knowledge',
        gradient: 'from-violet-500/20 to-violet-500/0',
        accent: 'text-violet-600 dark:text-violet-400',
        iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    },
]

export function AiStatTiles({ stats, onSelect }: { stats: AiStats; onSelect: (tab: AiTab) => void }) {
    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {TILES.map((tile, i) => {
                const value = stats[tile.key]
                const quiet = tile.mutedWhenZero && value === 0
                return (
                    <motion.button
                        key={tile.key}
                        type="button"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18, delay: i * 0.04 }}
                        onClick={() => onSelect(tile.tab)}
                        aria-label={`${tile.label}: ${value === null ? 'unknown' : value}. ${tile.cta}`}
                        className={cn(
                            'relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated transition-all duration-200 text-left',
                            'hover:shadow-lg hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
                        )}
                    >
                        {!quiet && <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', tile.gradient)} />}
                        <div className="relative">
                            <div className={cn(
                                'w-9 h-9 rounded-lg border flex items-center justify-center mb-3',
                                quiet ? 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border' : tile.iconBg,
                            )}>
                                <tile.icon className="w-4 h-4" />
                            </div>
                            <p className={cn('text-2xl font-bold', value === null ? 'text-ink-muted' : quiet ? 'text-ink' : tile.accent)}>
                                {value === null ? '—' : value.toLocaleString()}
                            </p>
                            <p className="text-xs text-ink-muted mt-1">{tile.label}</p>
                        </div>
                    </motion.button>
                )
            })}
        </div>
    )
}
