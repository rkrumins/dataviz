/**
 * ViewActivityTimeline — premium "who changed what, when" timeline for a view.
 *
 * Day-grouped vertical timeline. Each entry: an action-tinted node icon, the
 * actor, a human summary, relative time (exact on hover) and — for edits — an
 * expandable field-level diff. A "Changes only" toggle hides favourite/share
 * noise. Backed by ``useViewActivity`` (reads the dedicated activity log).
 */
import { useMemo, useState } from 'react'
import {
    Plus, Pencil, Eye, Lock, Users, Globe, Share2, UserMinus, Heart, HeartOff,
    Trash2, RotateCcw, Clock, History,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useViewActivity } from '@/hooks/useViewActivity'
import type { ViewActivityEntry, ViewActivityAction } from '@/services/viewApiService'

const ACTION_META: Record<ViewActivityAction, { icon: React.ElementType; tint: string; label: string; noise?: boolean }> = {
    created: { icon: Plus, tint: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20', label: 'Created' },
    updated: { icon: Pencil, tint: 'bg-violet-500/10 text-violet-500 border-violet-500/20', label: 'Edited' },
    visibility_changed: { icon: Eye, tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20', label: 'Visibility' },
    shared: { icon: Share2, tint: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', label: 'Shared', noise: true },
    unshared: { icon: UserMinus, tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20', label: 'Unshared', noise: true },
    favourited: { icon: Heart, tint: 'bg-rose-500/10 text-rose-500 border-rose-500/20', label: 'Favourited', noise: true },
    unfavourited: { icon: HeartOff, tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20', label: 'Unfavourited', noise: true },
    deleted: { icon: Trash2, tint: 'bg-red-500/10 text-red-500 border-red-500/20', label: 'Deleted' },
    restored: { icon: RotateCcw, tint: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', label: 'Restored' },
}

const VIS_ICON: Record<string, React.ElementType> = { private: Lock, workspace: Users, enterprise: Globe }

/** Human-readable diff lines from an entry's ``changes`` payload. */
function diffLines(e: ViewActivityEntry): string[] {
    const c = e.changes
    if (!c) return []
    const lines: string[] = []
    const ch = c as Record<string, { from?: unknown; to?: unknown } | unknown>
    const fromTo = (k: string) => ch[k] as { from?: unknown; to?: unknown }
    if (ch.name) lines.push(`Renamed “${fromTo('name').from}” → “${fromTo('name').to}”`)
    if (ch.viewType) lines.push(`Layout ${fromTo('viewType').from} → ${fromTo('viewType').to}`)
    if (ch.visibility) lines.push(`Visibility ${fromTo('visibility').from} → ${fromTo('visibility').to}`)
    if (ch.description) lines.push(fromTo('description').to ? 'Description updated' : 'Description cleared')
    if (ch.tags) lines.push('Tags updated')
    if (ch.pinned) lines.push((fromTo('pinned').to ? 'Pinned' : 'Unpinned') + ' the view')
    if (ch.content) lines.push('Content updated (filters / layout)')
    if (ch.role && ch.subjectType) lines.push(`As ${String(ch.role)}`)
    return lines
}

function dayLabel(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
    if (sameDay(d, now)) return 'Today'
    if (sameDay(d, yesterday)) return 'Yesterday'
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ViewActivityTimeline({ viewId }: { viewId: string }) {
    const { data, isLoading, error } = useViewActivity(viewId)
    const [changesOnly, setChangesOnly] = useState(false)

    const filtered = useMemo(() => {
        const rows = data ?? []
        return changesOnly ? rows.filter(r => !ACTION_META[r.action]?.noise) : rows
    }, [data, changesOnly])

    // Group consecutive entries by day for section headers.
    const groups = useMemo(() => {
        const out: { day: string; entries: ViewActivityEntry[] }[] = []
        for (const e of filtered) {
            const day = dayLabel(e.createdAt)
            const last = out[out.length - 1]
            if (last && last.day === day) last.entries.push(e)
            else out.push({ day, entries: [e] })
        }
        return out
    }, [filtered])

    if (isLoading) {
        return (
            <div className="space-y-4 p-1">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex gap-3 animate-pulse">
                        <div className="w-8 h-8 rounded-full bg-black/5 dark:bg-white/10 shrink-0" />
                        <div className="flex-1 space-y-2 pt-1">
                            <div className="h-3 w-2/3 rounded bg-black/5 dark:bg-white/10" />
                            <div className="h-2.5 w-1/3 rounded bg-black/5 dark:bg-white/10" />
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    if (error) {
        return <div className="py-10 text-center text-sm text-ink-muted">Couldn’t load activity. Try again.</div>
    }

    if ((data ?? []).length === 0) {
        return (
            <div className="py-14 text-center">
                <History className="w-9 h-9 mx-auto text-ink-muted opacity-30 mb-3" />
                <p className="text-sm font-semibold text-ink">No activity yet</p>
                <p className="text-xs text-ink-muted mt-1">Changes to this view will appear here.</p>
            </div>
        )
    }

    const noiseHidden = changesOnly && (data ?? []).length !== filtered.length

    return (
        <div>
            {/* Filter toggle */}
            <div className="flex items-center justify-end mb-3">
                <button
                    onClick={() => setChangesOnly(v => !v)}
                    className={cn(
                        'text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors',
                        changesOnly
                            ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20'
                            : 'text-ink-muted border-glass-border hover:text-ink',
                    )}
                >
                    {changesOnly ? 'Changes only' : 'All activity'}
                </button>
            </div>

            {groups.map(group => (
                <div key={group.day} className="mb-1">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-muted px-1 py-2 sticky top-0 bg-canvas-elevated/95 backdrop-blur-sm z-10">
                        {group.day}
                    </div>
                    <ol className="relative">
                        {group.entries.map((e, i) => {
                            const meta = ACTION_META[e.action] ?? ACTION_META.updated
                            const Icon = e.action === 'visibility_changed'
                                ? (VIS_ICON[String((e.changes as any)?.visibility?.to)] ?? Eye)
                                : meta.icon
                            const lines = diffLines(e)
                            const isLast = i === group.entries.length - 1
                            return (
                                <li key={e.id} className="relative flex gap-3 pb-4">
                                    {/* connector line */}
                                    {!isLast && <span className="absolute left-4 top-9 bottom-0 w-px bg-glass-border" aria-hidden />}
                                    {/* node */}
                                    <div className={cn('relative z-[1] w-8 h-8 rounded-full border flex items-center justify-center shrink-0', meta.tint)}>
                                        <Icon className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0 pt-0.5">
                                        <div className="flex items-baseline gap-2 flex-wrap">
                                            <span className="text-sm text-ink">
                                                <span className="font-semibold">{e.actorName ?? (e.actor && e.actor !== 'anonymous' ? 'A teammate' : 'System')}</span>
                                                {' '}
                                                <span className="text-ink-muted">{e.summary ?? meta.label.toLowerCase()}</span>
                                            </span>
                                            {e.synthetic && (
                                                <span className="text-[9px] uppercase tracking-wide text-ink-muted border border-glass-border rounded px-1 py-0.5">pre-tracking</span>
                                            )}
                                            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-muted shrink-0" title={new Date(e.createdAt).toLocaleString()}>
                                                <Clock className="w-3 h-3" /> {timeAgo(e.createdAt)}
                                            </span>
                                        </div>
                                        {lines.length > 0 && (
                                            <ul className="mt-1.5 space-y-1">
                                                {lines.map((l, li) => (
                                                    <li key={li} className="text-xs text-ink-muted flex items-center gap-1.5">
                                                        <span className="w-1 h-1 rounded-full bg-ink-muted/50 shrink-0" />
                                                        {l}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                    </ol>
                </div>
            ))}

            {noiseHidden && (
                <button onClick={() => setChangesOnly(false)} className="w-full text-center text-[11px] text-ink-muted hover:text-ink py-2">
                    Show favourites &amp; shares
                </button>
            )}
        </div>
    )
}
