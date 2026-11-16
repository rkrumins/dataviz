/**
 * Where a graph's setting came from, said from the graph's side (`SOURCE_WORDS`): this graph, this
 * workspace, the platform, the deployment's environment, or the default; with the level's glyph
 * from the settings kit, so it reads as the trail does in the graph's settings drawer.
 */
import { Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SCOPE_ICON } from '@/components/settings/meta'
import type { TrailScope } from '@/components/settings/types'
import { SOURCE_WORDS } from '../model/settingWords'

export function SourceChip({ source, className }: { source: TrailScope | 'env'; className?: string }) {
    const Icon = source === 'env' ? Server : SCOPE_ICON[source]
    return (
        <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-black/[0.05] px-1.5 py-px text-[11px] font-medium leading-4 text-ink-secondary dark:bg-white/[0.07]', className)}>
            <Icon aria-hidden className="w-3 h-3 shrink-0" />
            <span><span className="sr-only">From </span>{SOURCE_WORDS[source]}</span>
        </span>
    )
}
