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
 *
 * Each tile is also the way *to* the thing it counts. "3 drafts to
 * rehearse" is a call to action rendered as a statistic; leaving the
 * operator to translate it into "open Providers and look for the amber
 * ones" was work the page could do for them.
 */
import type { ReactNode } from 'react'
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
    /** What pressing it does, said in the accessible name. A tile that
     *  navigates has to announce where. */
    cta: string
}[] = [
    {
        key: 'live', label: 'Live connections', icon: Wifi,
        gradient: 'from-emerald-500/20 to-emerald-500/0',
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        cta: 'Show every connection',
    },
    {
        key: 'drafts', label: 'Drafts to rehearse', icon: FlaskConical,
        gradient: 'from-amber-500/20 to-amber-500/0',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        mutedWhenZero: true,
        cta: 'Show only the drafts',
    },
    {
        key: 'rules', label: 'Access rules', icon: Waypoints,
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        accent: 'text-indigo-600 dark:text-indigo-400',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
        cta: 'Open access mapping',
    },
    {
        key: 'failures24h', label: 'Failed sign-ins (24h)', icon: AlertTriangle,
        gradient: 'from-red-500/20 to-red-500/0',
        accent: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-500/10 text-red-500 border-red-500/20',
        mutedWhenZero: true,
        cta: 'Open diagnostics',
    },
]

export function SsoStatTiles({
    stats, onSelect,
}: {
    stats: SsoStats
    /** Omit for a read-only row; the tiles then render as plain figures. */
    onSelect?: (key: keyof SsoStats) => void
}) {
    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {TILES.map((tile, i) => {
                const value = stats[tile.key]
                const zero = value === 0
                // A zero failure count is good news, so it should not shout
                // in red; the tile stays but drops to the neutral palette.
                const quiet = tile.mutedWhenZero && zero
                // "0 drafts" would filter the list down to nothing, which is
                // a dead end rather than a destination. Every other tile
                // leads somewhere worth arriving at even when empty.
                const live = Boolean(onSelect) && !(tile.key === 'drafts' && zero)

                const body = (
                    <>
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
                    </>
                )

                return (
                    <Tile
                        key={tile.key}
                        index={i}
                        onClick={live ? () => onSelect!(tile.key) : undefined}
                        label={`${tile.label}: ${value === null ? 'unknown' : value}. ${tile.cta}`}
                    >
                        {body}
                    </Tile>
                )
            })}
        </div>
    )
}

const SHELL = 'relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated transition-all duration-200'

/**
 * The same surface either way.
 *
 * Split rather than swapping the element on `motion.div`/`motion.button`
 * inline, because the two take different props and a union of them is
 * three lines of type gymnastics to save six of markup.
 */
function Tile({
    index, onClick, label, children,
}: {
    index: number
    onClick?: () => void
    label: string
    children: ReactNode
}) {
    const anim = {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.18, delay: index * 0.04 },
    }

    if (!onClick) {
        return <motion.div {...anim} className={SHELL}>{children}</motion.div>
    }
    return (
        <motion.button
            {...anim}
            type="button"
            onClick={onClick}
            aria-label={label}
            className={cn(
                SHELL,
                'text-left hover:shadow-lg hover:-translate-y-0.5 hover:border-glass-border/80',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
            )}
        >
            {children}
        </motion.button>
    )
}
