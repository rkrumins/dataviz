/**
 * ActivityFeedList — the shared presentation for an activity feed.
 *
 * SINGLE source of the action→icon/tint/verb mapping and the row markup,
 * consumed by both WorkspaceActivityFeed (workspace-scoped) and
 * DashboardActivityFeed (everything the user can see). Purely presentational —
 * each caller brings its own hook — so the two feeds can never drift apart the
 * way the view-type maps did across the Explorer surfaces.
 *
 * ── Why the row is COMPOSED rather than concatenated ────────────────────────
 *
 * The first version rendered `{summary} · {viewName}`, which printed the view
 * name twice on every create/delete/restore row:
 *
 *     System Admin  Created "Impact Analysis" · Impact Analysis
 *
 * because the server embeds the name in those summaries and we appended the link
 * as well. The summaries are a durable AUDIT record (they also feed the outbox
 * event log), so they aren't the thing to change — the presentation is.
 *
 * So each action declares its own VERB, and the view name is rendered exactly
 * once, as the link. `summary` is shown only for the actions where it carries
 * information the verb does not: what a rename changed, which visibility
 * transition happened, who a view was shared with. For the rest ("Created
 * "X"", "Underlying data updated") the verb already says it, and the summary is
 * dropped as redundant.
 *
 * ── Why consecutive events COLLAPSE ────────────────────────────────────────
 *
 * A republished data source emits one data_changed per affected view, so the
 * raw feed reads "Underlying data updated · Impact Analysis" three times in a
 * row. Identical adjacent events (same person, same action, same view) fold into
 * one row with a ×N badge, so the feed shows what HAPPENED rather than how many
 * rows the write path produced.
 */
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
    Plus, Pencil, Eye, Share2, UserMinus, Heart, HeartOff, Trash2, RotateCcw,
    Database, History, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewActivityAction, ViewActivityEntry } from '@/services/viewApiService'

interface ActionMeta {
    icon: React.ElementType
    /** Badge tint for the action dot. */
    tint: string
    /** The verb, phrased so it reads as "<Person> <verb> <View>". */
    verb: string
    /** Does `summary` add anything the verb doesn't? If false it's dropped. */
    summaryAddsDetail: boolean
}

const META: Record<ViewActivityAction, ActionMeta> = {
    created: { icon: Plus, tint: 'bg-indigo-500/10 text-indigo-500 ring-indigo-500/20', verb: 'created', summaryAddsDetail: false },
    updated: { icon: Pencil, tint: 'bg-violet-500/10 text-violet-500 ring-violet-500/20', verb: 'updated', summaryAddsDetail: true },
    data_changed: { icon: Database, tint: 'bg-blue-500/10 text-blue-500 ring-blue-500/20', verb: 'published new data to', summaryAddsDetail: false },
    visibility_changed: { icon: Eye, tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20', verb: 'changed who can see', summaryAddsDetail: true },
    shared: { icon: Share2, tint: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20', verb: 'shared', summaryAddsDetail: true },
    unshared: { icon: UserMinus, tint: 'bg-slate-500/10 text-slate-500 ring-slate-500/20', verb: 'revoked access to', summaryAddsDetail: true },
    deleted: { icon: Trash2, tint: 'bg-red-500/10 text-red-500 ring-red-500/20', verb: 'deleted', summaryAddsDetail: false },
    restored: { icon: RotateCcw, tint: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20', verb: 'restored', summaryAddsDetail: false },
    favourited: { icon: Heart, tint: 'bg-rose-500/10 text-rose-500 ring-rose-500/20', verb: 'favourited', summaryAddsDetail: false },
    unfavourited: { icon: HeartOff, tint: 'bg-slate-500/10 text-slate-500 ring-slate-500/20', verb: 'unfavourited', summaryAddsDetail: false },
}

const FALLBACK: ActionMeta = META.updated

/** "Visibility enterprise → workspace" reads better as just the transition. */
function detailFor(entry: ViewActivityEntry, meta: ActionMeta): string | null {
    if (!meta.summaryAddsDetail || !entry.summary) return null
    return entry.summary.replace(/^Visibility\s+/i, '')
}

function actorLabel(entry: ViewActivityEntry): string {
    if (entry.actorName) return entry.actorName
    if (entry.actor && entry.actor !== 'anonymous') return 'A teammate'
    return 'System'
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Deterministic avatar tint — the same person keeps the same colour everywhere. */
const AVATAR_TINTS = [
    'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    'bg-rose-500/15 text-rose-600 dark:text-rose-300',
    'bg-sky-500/15 text-sky-600 dark:text-sky-300',
    'bg-violet-500/15 text-violet-600 dark:text-violet-300',
]

function avatarTint(key: string): string {
    let hash = 0
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
    return AVATAR_TINTS[hash % AVATAR_TINTS.length]
}

// ── Day bucketing ──────────────────────────────────────────────────────────

function dayKey(iso: string): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? 'unknown' : d.toDateString()
}

function dayLabel(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'Earlier'

    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)

    if (d.toDateString() === today.toDateString()) return 'Today'
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'

    return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    })
}

/** One rendered row — possibly several identical events folded together. */
interface Row {
    entry: ViewActivityEntry
    count: number
}

interface DayGroup {
    key: string
    label: string
    rows: Row[]
}

/**
 * Group by day, folding runs of identical adjacent events into one row.
 * Exported for tests: this is the logic that turns 3 raw data_changed rows into
 * a single "×3", so it's worth pinning down.
 */
export function groupActivity(entries: ViewActivityEntry[]): DayGroup[] {
    const groups: DayGroup[] = []

    for (const entry of entries) {
        const key = dayKey(entry.createdAt)
        let group = groups[groups.length - 1]

        if (!group || group.key !== key) {
            group = { key, label: dayLabel(entry.createdAt), rows: [] }
            groups.push(group)
        }

        const last = group.rows[group.rows.length - 1]
        const isRepeat = last
            && last.entry.action === entry.action
            && last.entry.viewId === entry.viewId
            && last.entry.actor === entry.actor

        // Entries arrive newest-first, so the row keeps the NEWEST timestamp and
        // just counts the older duplicates behind it.
        if (isRepeat) last.count += 1
        else group.rows.push({ entry, count: 1 })
    }

    return groups
}

// ── Rendering ──────────────────────────────────────────────────────────────

function ActivityRow({ row, index }: { row: Row; index: number }) {
    const { entry, count } = row
    const meta = META[entry.action] ?? FALLBACK
    const Icon = meta.icon
    const who = actorLabel(entry)
    const detail = detailFor(entry, meta)

    return (
        <motion.li
            className="relative"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            // Cap the stagger: with 24 rows an uncapped delay makes the last
            // row land nearly a second late, which reads as jank, not polish.
            transition={{ duration: 0.18, delay: Math.min(index, 8) * 0.025 }}
        >
            <Link
                to={`/views/${entry.viewId}`}
                className="group flex items-start gap-3 rounded-xl px-2.5 py-2.5 -mx-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
            >
                {/* Avatar + the action badge that sits on it */}
                <span className="relative shrink-0">
                    <span className={cn(
                        'w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold',
                        avatarTint(entry.actor ?? who),
                    )}>
                        {initials(who)}
                    </span>
                    <span className={cn(
                        'absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center ring-2 ring-canvas-elevated',
                        meta.tint,
                    )}>
                        <Icon className="w-2.5 h-2.5" />
                    </span>
                </span>

                <span className="min-w-0 flex-1 pt-0.5">
                    <span className="block text-[13px] leading-snug text-ink-muted">
                        <span className="font-semibold text-ink">{who}</span>{' '}
                        {meta.verb}{' '}
                        {entry.viewName ? (
                            <span className="font-semibold text-ink group-hover:text-accent-lineage transition-colors">
                                {entry.viewName}
                            </span>
                        ) : (
                            <span className="font-semibold text-ink">this view</span>
                        )}
                        {count > 1 && (
                            <span className="ml-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-black/5 dark:bg-white/10 text-ink-muted align-middle">
                                ×{count}
                            </span>
                        )}
                    </span>

                    {detail && (
                        <span className="block mt-0.5 text-[11.5px] text-ink-muted/80 truncate">
                            {detail}
                        </span>
                    )}
                </span>

                <span className="shrink-0 flex items-center gap-1 pt-0.5">
                    <span
                        className="text-[11px] text-ink-muted tabular-nums"
                        title={new Date(entry.createdAt).toLocaleString()}
                    >
                        {timeAgo(entry.createdAt)}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-ink-muted opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </span>
            </Link>
        </motion.li>
    )
}

export function ActivityFeedList({ entries, isLoading, emptyText, skeletonRows = 4 }: {
    entries: ViewActivityEntry[]
    isLoading?: boolean
    emptyText: string
    skeletonRows?: number
}) {
    if (isLoading) {
        return (
            <div className="space-y-3 py-2">
                {Array.from({ length: skeletonRows }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                        <div className="w-9 h-9 rounded-full bg-black/5 dark:bg-white/10 shrink-0" />
                        <div className="h-3 flex-1 max-w-md rounded bg-black/5 dark:bg-white/10" />
                    </div>
                ))}
            </div>
        )
    }

    if (entries.length === 0) {
        return (
            <div className="py-10 text-center">
                <History className="w-7 h-7 mx-auto text-ink-muted opacity-30 mb-2" />
                <p className="text-xs text-ink-muted">{emptyText}</p>
            </div>
        )
    }

    const groups = groupActivity(entries)

    return (
        <div className="py-1">
            {groups.map(group => (
                <section key={group.key} className="relative">
                    <h3 className="sticky top-0 z-10 bg-canvas-elevated/95 backdrop-blur-sm py-2 text-[10px] font-bold uppercase tracking-wider text-ink-muted/70">
                        {group.label}
                    </h3>

                    {/* The rail the avatars hang off — the spine of the timeline. */}
                    <ul className="relative space-y-0.5 pb-2">
                        <span
                            aria-hidden
                            className="absolute left-[18px] top-2 bottom-4 w-px bg-glass-border"
                        />
                        {group.rows.map((row, i) => (
                            <ActivityRow key={row.entry.id} row={row} index={i} />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    )
}
