/**
 * What letting someone into a workspace opens: every role there reads every
 * data source in it — there are no per-source grants inside a workspace —
 * so whoever grants access sees the list, restricted sources marked.
 * Shown when answering a request and in Add member.
 */
import { Database, Lock } from 'lucide-react'

import type { WorkspaceGrantOptions } from '@/services/workspaceMembersService'
import { cn } from '@/lib/utils'

const SHOWN = 4

export function WorkspaceReachNote({ sources }: { sources: WorkspaceGrantOptions['dataSources'] }) {
    if (!sources?.length) return null
    const restricted = sources.filter(s => s.restricted)
    // Restricted sources first: they're the ones to think about.
    const listed = [...restricted, ...sources.filter(s => !s.restricted)].slice(0, SHOWN)
    const more = sources.length - listed.length
    return (
        <div
            role="note"
            className={cn(
                'flex items-start gap-2 rounded-xl border px-3 py-2 text-xs',
                restricted.length
                    ? 'border-amber-500/30 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300'
                    : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.03] text-ink-secondary',
            )}
        >
            <Database className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
            <span>
                {sources.length === 1
                    ? `Any role here reads this workspace’s data source${restricted.length ? ', which is restricted' : ''}: `
                    : `Any role here reads all ${sources.length} data sources in this workspace${restricted.length ? ', restricted ones included' : ''}: `}
                {listed.map((s, i) => (
                    <span key={s.id} className="whitespace-nowrap">
                        {i > 0 && ', '}
                        {s.restricted && <Lock className="inline w-3 h-3 -mt-0.5 mr-0.5" aria-label="Restricted" />}
                        <span className="font-semibold">{s.label || s.id}</span>
                    </span>
                ))}
                {more > 0 && ` and ${more} more`}.
            </span>
        </div>
    )
}
