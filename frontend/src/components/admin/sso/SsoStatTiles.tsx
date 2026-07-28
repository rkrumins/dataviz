/**
 * The orientation row every other Admin page opens with.
 *
 * Groups, Users, Permissions and Overview all lead with a row of stat
 * tiles; SSO was the one that did not, which is part of why it read as a
 * different product. Same shape as `AdminGroups`' `KPI_CARDS` — gradient
 * wash, bordered icon tile, big number, quiet label.
 *
 * The four chosen are the ones an operator would otherwise have to open a
 * tab to learn, and two of them are the states that actually go wrong:
 * a connection stuck in draft because nobody rehearsed it, and sign-ins
 * failing right now.
 */
import { motion } from 'framer-motion'
import { AlertTriangle, FlaskConical, Waypoints, Wifi } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SsoStats {
    live: number
    drafts: number
    rules: number
    /** Null when the audit read failed or the operator cannot read it —
     *  rendered as an em dash rather than a confident zero. */
    failures24h: number | null
}

const TILES: {
    key: keyof SsoStats
    label: string
    icon: LucideIcon
    gradient: string
    accent: string
    iconBg: string
    /** Only interesting when non-zero — a quiet zero is the good state. */
    mutedWhenZero?: boolean
}[] = [
    {
        key: 'live', label: 'Live connections', icon: Wifi,
        gradient: 'from-emerald-500/20 to-emerald-500/0',
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    },
    {
        key: 'drafts', label: 'Drafts to rehearse', icon: FlaskConical,
        gradient: 'from-amber-500/20 to-amber-500/0',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        mutedWhenZero: true,
    },
    {
        key: 'rules', label: 'Access rules', icon: Waypoints,
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        accent: 'text-indigo-600 dark:text-indigo-400',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    },
    {
        key: 'failures24h', label: 'Failed sign-ins (24h)', icon: AlertTriangle,
        gradient: 'from-red-500/20 to-red-500/0',
        accent: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-500/10 text-red-500 border-red-500/20',
        mutedWhenZero: true,
    },
]

export function SsoStatTiles({ stats }: { stats: SsoStats }) {
    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {TILES.map((tile, i) => {
                const value = stats[tile.key]
                const zero = value === 0
                // A zero failure count is good news, so it should not shout
                // in red; the tile stays but drops to the neutral palette.
                const quiet = tile.mutedWhenZero && zero
                return (
                    <motion.div
                        key={tile.key}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18, delay: i * 0.04 }}
                        className="relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated hover:shadow-lg transition-colors duration-200"
                    >
                        {!quiet && (
                            <div className={cn(
                                'absolute inset-0 bg-gradient-to-br pointer-events-none',
                                tile.gradient,
                            )} />
                        )}
                        <div className="relative">
                            <div className={cn(
                                'w-9 h-9 rounded-lg border flex items-center justify-center mb-3',
                                quiet
                                    ? 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border'
                                    : tile.iconBg,
                            )}>
                                <tile.icon className="w-4 h-4" />
                            </div>
                            <p className={cn(
                                'text-2xl font-bold',
                                value === null ? 'text-ink-muted'
                                    : quiet ? 'text-ink' : tile.accent,
                            )}>
                                {value === null ? '—' : value}
                            </p>
                            <p className="text-xs text-ink-muted mt-1">{tile.label}</p>
                        </div>
                    </motion.div>
                )
            })}
        </div>
    )
}
