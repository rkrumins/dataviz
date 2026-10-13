/**
 * What a key can do right now: its owner's access today, narrowed by the key.
 *
 * A matrix of levels per workspace — or one "Every workspace" row when the
 * reach comes through an organisation-wide role, which is a statement about
 * every workspace there will ever be, not a list to scroll — then each picked
 * view and data source with what the key gets on it.
 */
import { AlertTriangle, Building2, Database, Eye, Globe2, Megaphone } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { EffectiveAccess, Level, ResourceAccess } from '@/services/apiKeyService'
import { LevelPill } from './parts'

const EDGE = 'border-black/[0.07] dark:border-white/[0.08]'

export function AccessMatrix({ access, className }: { access: EffectiveAccess; className?: string }) {
    const { workspaces, views, dataSources, everyWorkspace } = access
    const nothing = !everyWorkspace && workspaces.length === 0 && views.length === 0 && dataSources.length === 0
    if (nothing) {
        return (
            <p className={cn('flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-xs text-amber-700 dark:text-amber-300', className)}>
                <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
                Nothing at the moment: you no longer have access to what it was limited to.
            </p>
        )
    }
    return (
        <div className={cn('space-y-4', className)}>
            {(everyWorkspace || workspaces.length > 0) && (
                <div className={cn('rounded-xl border overflow-hidden', EDGE)}>
                    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 px-3.5 py-2 border-b bg-black/[0.02] dark:bg-white/[0.03] text-[10px] font-semibold uppercase tracking-wider text-ink-muted', EDGE)}>
                        <span>Workspace</span>
                        <span className="w-[88px]">Views</span>
                        <span className="w-[88px]">Data</span>
                    </div>
                    {everyWorkspace ? (
                        <Row
                            icon={Globe2}
                            name="Every workspace"
                            caption="Through your organisation-wide role — including workspaces made later"
                            views={everyWorkspace.views}
                            data={everyWorkspace.data}
                            publish={everyWorkspace.publish}
                        />
                    ) : workspaces.map((w) => (
                        <Row key={w.id} icon={Building2} name={w.name} views={w.views} data={w.data} publish={w.publish} />
                    ))}
                </div>
            )}
            <Resources title="Views" icon={Eye} items={views} />
            <Resources title="Data sources" icon={Database} items={dataSources} />
        </div>
    )
}

function Row({ icon: Icon, name, caption, views, data, publish }: {
    icon: typeof Globe2
    name: string
    caption?: string
    views: Level
    data: Level
    publish: boolean
}) {
    return (
        <div className={cn('grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-3.5 py-2.5 border-b last:border-0', EDGE)}>
            <span className="min-w-0 flex items-start gap-2">
                <Icon className="w-3.5 h-3.5 mt-0.5 text-ink-muted shrink-0" aria-hidden />
                <span className="min-w-0">
                    <span className="block text-xs font-semibold text-ink truncate">{name}</span>
                    {caption && <span className="block text-[11px] text-ink-muted leading-snug">{caption}</span>}
                    {publish && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                            <Megaphone className="w-3 h-3" aria-hidden /> Can publish
                        </span>
                    )}
                </span>
            </span>
            <span className="w-[88px]"><LevelPill level={views} /></span>
            <span className="w-[88px]"><LevelPill level={data} /></span>
        </div>
    )
}

function Resources({ title, icon: Icon, items }: { title: string; icon: typeof Eye; items: ResourceAccess[] }) {
    if (items.length === 0) return null
    return (
        <div>
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                <Icon className="w-3.5 h-3.5" aria-hidden /> {title}
            </p>
            <ul className={cn('rounded-xl border divide-y overflow-hidden', EDGE, 'divide-black/[0.07] dark:divide-white/[0.08]')}>
                {items.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-3.5 py-2">
                        <span className={cn('flex-1 min-w-0 text-xs truncate', r.level === 'none' ? 'text-ink-muted line-through' : 'text-ink')}>
                            {r.name ?? r.id}
                        </span>
                        {r.level === 'none'
                            ? <span className="text-[11px] text-amber-600 dark:text-amber-400 shrink-0">Out of reach</span>
                            : <LevelPill level={r.level} />}
                    </li>
                ))}
            </ul>
        </div>
    )
}
