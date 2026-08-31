/**
 * ViewActivityTimeline — premium "who changed what, when" timeline for a view.
 *
 * Day-grouped vertical timeline across two channels — Settings (config /
 * lifecycle) and Data (graph publish/merge that changed what the view shows) —
 * plus Sharing. Each entry: an action-tinted node icon, the actor (avatar +
 * hover card), a human summary, relative time (exact on hover) and — for edits
 * — an expandable field-level diff. Segmented channel filter + filter-by-person
 * keep a busy history scannable. Backed by ``useViewActivity``.
 */
import { useMemo, useState } from 'react'
import {
    Plus, Pencil, Eye, Lock, Users, Globe, Share2, UserMinus, Heart, HeartOff,
    Trash2, RotateCcw, Clock, History, Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useViewActivity } from '@/hooks/useViewActivity'
import { CreatorHoverCard } from '@/components/explorer/CreatorHoverCard'
import type { ViewActivityEntry, ViewActivityAction } from '@/services/viewApiService'

type Channel = 'data' | 'settings' | 'sharing'

const ACTION_META: Record<ViewActivityAction, { icon: React.ElementType; tint: string; label: string; channel: Channel }> = {
    data_changed: { icon: Database, tint: 'bg-blue-500/10 text-blue-500 border-blue-500/20', label: 'Data updated', channel: 'data' },
    created: { icon: Plus, tint: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20', label: 'Created', channel: 'settings' },
    updated: { icon: Pencil, tint: 'bg-violet-500/10 text-violet-500 border-violet-500/20', label: 'Edited', channel: 'settings' },
    visibility_changed: { icon: Eye, tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20', label: 'Visibility', channel: 'settings' },
    deleted: { icon: Trash2, tint: 'bg-red-500/10 text-red-500 border-red-500/20', label: 'Deleted', channel: 'settings' },
    restored: { icon: RotateCcw, tint: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', label: 'Restored', channel: 'settings' },
    shared: { icon: Share2, tint: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', label: 'Shared', channel: 'sharing' },
    unshared: { icon: UserMinus, tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20', label: 'Unshared', channel: 'sharing' },
    favourited: { icon: Heart, tint: 'bg-rose-500/10 text-rose-500 border-rose-500/20', label: 'Favourited', channel: 'sharing' },
    unfavourited: { icon: HeartOff, tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20', label: 'Unfavourited', channel: 'sharing' },
}

const CHANNELS: { key: Channel | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'data', label: 'Data' },
    { key: 'settings', label: 'Settings' },
    { key: 'sharing', label: 'Sharing' },
]

const VIS_ICON: Record<string, React.ElementType> = { private: Lock, workspace: Users, enterprise: Globe }

function initials(name: string | null): string {
    if (!name) return '·'
    return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '·'
}

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
    const [channel, setChannel] = useState<Channel | 'all'>('all')
    const [actorId, setActorId] = useState<string>('all')

    // Distinct actors for the person filter.
    const actors = useMemo(() => {
        const map = new Map<string, string>()
        for (const e of data ?? []) {
            if (e.actor && e.actor !== 'anonymous') map.set(e.actor, e.actorName ?? e.actor)
        }
        return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
    }, [data])

    const filtered = useMemo(() => {
        return (data ?? []).filter(e => {
            if (channel !== 'all' && (ACTION_META[e.action]?.channel ?? 'settings') !== channel) return false
            if (actorId !== 'all' && e.actor !== actorId) return false
            return true
        })
    }, [data, channel, actorId])

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

    return (
        <div>
            {/* Filters: channel segmented control + person */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
                <div className="inline-flex items-center rounded-xl border border-glass-border p-0.5 bg-black/[0.02] dark:bg-white/[0.02]">
                    {CHANNELS.map(c => (
                        <button
                            key={c.key}
                            onClick={() => setChannel(c.key)}
                            className={cn(
                                'px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors',
                                channel === c.key ? 'bg-indigo-500 text-white' : 'text-ink-muted hover:text-ink',
                            )}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
                {actors.length > 1 && (
                    <select
                        value={actorId}
                        onChange={e => setActorId(e.target.value)}
                        className="ml-auto px-2.5 py-1.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-xs text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/40 max-w-[160px]"
                    >
                        <option value="all">Everyone</option>
                        {actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                )}
            </div>

            {groups.length === 0 ? (
                <div className="py-10 text-center text-sm text-ink-muted">No {channel !== 'all' ? channel : ''} activity{actorId !== 'all' ? ' for this person' : ''}.</div>
            ) : groups.map(group => (
                <div key={group.day} className="mb-1">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-muted px-1 py-2 sticky top-0 bg-canvas-elevated z-10">
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
                            const who = e.actorName ?? (e.actor && e.actor !== 'anonymous' ? 'A teammate' : 'System')
                            return (
                                <li key={e.id} className="relative flex gap-3 pb-4">
                                    {!isLast && <span className="absolute left-4 top-9 bottom-0 w-px bg-glass-border" aria-hidden />}
                                    <div className={cn('relative z-[1] w-8 h-8 rounded-full border flex items-center justify-center shrink-0', meta.tint)}>
                                        <Icon className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0 pt-0.5">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <CreatorHoverCard userId={e.actor} displayName={e.actorName} email={e.actorEmail} accentClassName={meta.tint}>
                                                <span className="inline-flex items-center gap-1.5 cursor-default" tabIndex={0}>
                                                    <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold border', meta.tint)}>
                                                        {initials(e.actorName)}
                                                    </span>
                                                    <span className="text-sm font-semibold text-ink">{who}</span>
                                                </span>
                                            </CreatorHoverCard>
                                            <span className="text-sm text-ink-muted">{e.summary ?? meta.label.toLowerCase()}</span>
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
        </div>
    )
}
