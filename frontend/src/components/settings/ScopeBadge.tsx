/**
 * ScopeBadge — which level a value belongs to: Default, Platform, Workspace or Graph, each with
 * its own glyph so the trail and the row read at a glance; or the deployment, when its env var set
 * the default. `here` marks the level being edited, with a firmer edge rather than the accent,
 * which the kit keeps for a staged change.
 */
import { Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SCOPE_LABEL } from './format'
import { SCOPE_ICON } from './meta'
import type { TrailScope } from './types'

export function ScopeBadge({ scope, here = false, prefix, className }: {
    scope: TrailScope | 'env'
    /** The level being edited: outlined in the accent. */
    here?: boolean
    /** Words before the level: "From", "Set for". */
    prefix?: string
    className?: string
}) {
    const Icon = scope === 'env' ? Server : SCOPE_ICON[scope]
    return (
        <span className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap',
            here ? 'border border-ink/25 text-ink dark:border-white/25' : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.07]',
            className,
        )}>
            <Icon className="w-3 h-3 shrink-0" aria-hidden />
            {/* One run of text, so it reads "From Platform", not "FromPlatform". */}
            <span>{prefix && <span className="font-normal">{prefix} </span>}{scope === 'env' ? 'Your deployment' : SCOPE_LABEL[scope]}</span>
        </span>
    )
}
