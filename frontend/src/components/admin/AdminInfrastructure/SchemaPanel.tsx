/**
 * SchemaPanel — the database schema: where it stands against this server's migrations, what an
 * upgrade with this build would do (the upgrade Job's own decision, `synodic-upgrade plan`), and
 * what upgrades have done to it (alembic_history).
 *
 * Read live by the server on each poll, not from the startup snapshot the Viz Service tile's
 * `schemaAtHead` comes from.
 */
import { useState } from 'react'
import {
    AlertTriangle, ArrowRight, Check, Copy, Database, GitBranch, GitCommitHorizontal, KeyRound,
    Layers, ListOrdered, RefreshCw, Server, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SchemaHistoryEntry } from '@/services/systemStatusService'
import { formatSince } from './meta'
import { TONE_STYLES, kindMeta, readRevision, schemaHeadline, type Tone } from './schemaMeta'
import { useSchemaStatus } from './useSchemaStatus'

const PENDING_SHOWN = 8
const HISTORY_SHOWN = 8

/** A revision id, copied with a click. */
function CopyId({ id }: { id: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            type="button"
            aria-label={`Copy ${id}`}
            title="Copy the revision id"
            onClick={() => {
                void navigator.clipboard?.writeText(id)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10"
        >
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
        </button>
    )
}

/** A revision as a name and when it was written, its id beneath. */
function Revision({ id, strong = false }: { id: string; strong?: boolean }) {
    const { name, written } = readRevision(id)
    return (
        <div className="group min-w-0">
            <div className={cn('truncate', strong ? 'text-[13px] font-semibold text-ink' : 'text-[12px] text-ink')} title={name}>
                {name}
            </div>
            <div className="flex items-center gap-1 min-w-0">
                <span className="font-mono text-[10.5px] text-ink-muted truncate" title={id}>{id}</span>
                <CopyId id={id} />
            </div>
            {written && <div className="text-[10.5px] text-ink-muted/80">written {written}</div>}
        </div>
    )
}

function StatCard({ icon: Icon, label, accent, children }: {
    icon: typeof Layers; label: string; accent: string; children: React.ReactNode
}) {
    return (
        <div className="relative overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-4 transition-shadow hover:shadow-md">
            <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent', accent)} />
            <div className="relative">
                <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">
                    <Icon className="w-3.5 h-3.5" /> {label}
                </div>
                <div className="mt-2 min-w-0">{children}</div>
            </div>
        </div>
    )
}

function Chip({ tone, children }: { tone: 'indigo' | 'amber' | 'emerald'; children: React.ReactNode }) {
    const cls = {
        indigo: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
        amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    }[tone]
    return <span className={cn('inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px]', cls)}>{children}</span>
}

function Callout({ tone, icon: Icon, children }: { tone: 'amber' | 'violet'; icon: typeof AlertTriangle; children: React.ReactNode }) {
    return (
        <div className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12px]',
            tone === 'amber'
                ? 'border-amber-500/25 bg-amber-500/[0.07] text-amber-800 dark:text-amber-200'
                : 'border-violet-500/25 bg-violet-500/[0.06] text-ink')}>
            <Icon className={cn('w-4 h-4 mt-px shrink-0', tone === 'amber' ? 'text-amber-500' : 'text-violet-500')} />
            <div className="min-w-0">{children}</div>
        </div>
    )
}

function HistoryItem({ h, last }: { h: SchemaHistoryEntry; last: boolean }) {
    const meta = kindMeta(h.kind)
    const Icon = meta.icon
    return (
        <li className="relative flex gap-3 pb-3">
            {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-glass-border" aria-hidden />}
            <span className={cn('relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full ring-1', meta.node)}>
                <Icon className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[12px] font-semibold text-ink">{meta.label}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-ink-muted">
                        {h.build && (
                            <span className="hidden md:inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-muted/80">
                                <GitCommitHorizontal className="w-3 h-3" /> {h.build}
                            </span>
                        )}
                        <span title={h.at ?? undefined}>{formatSince(h.at) ?? ''}</span>
                    </span>
                </div>
                <div className="group flex items-center gap-1 min-w-0">
                    <span className="truncate text-[11.5px] text-ink-muted" title={h.revision}>{readRevision(h.revision).name}</span>
                    <span className="font-mono text-[10.5px] text-ink-muted/70 truncate hidden sm:inline">{h.revision}</span>
                    <CopyId id={h.revision} />
                </div>
            </div>
        </li>
    )
}

function Skeleton() {
    return (
        <div className="mt-5 space-y-3 animate-pulse" aria-label="Reading the schema">
            <div className="h-16 rounded-xl bg-black/5 dark:bg-white/5" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl bg-black/5 dark:bg-white/5" />)}
            </div>
            <p className="sr-only">Reading the schema…</p>
        </div>
    )
}

export function SchemaPanel() {
    const { data, error, isLoading, isFetching, refetch, dataUpdatedAt } = useSchemaStatus()
    const [allHistory, setAllHistory] = useState(false)
    const [allPending, setAllPending] = useState(false)

    const head = data ? schemaHeadline(data) : null
    const tone: Tone = head?.tone ?? 'good'
    const style = TONE_STYLES[tone]
    const BannerIcon = style.icon
    const checked = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null
    const notGranted = (data?.lastSeeded?.detail?.notGranted as string[] | undefined) ?? []
    // The title already says how many; say what happens to them instead.
    const sentence = data?.plan.verdict === 'upgrade' && data.plan.wouldRun.length
        ? 'Each runs in a transaction of its own, in the order below; a backup is taken first where the Helm chart runs the upgrade.'
        : data?.plan.reason

    return (
        <section aria-label="Database schema"
            className="relative overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm">
            {/* Header */}
            <div className="flex items-center gap-3">
                <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-lg',
                    data ? cn(style.tile, style.glow) : 'from-indigo-500 to-violet-600 shadow-indigo-500/20')}>
                    <Database className="h-5 w-5 text-white" />
                </div>
                <div className="min-w-0">
                    <h3 className="text-base font-bold tracking-tight text-ink">Database schema</h3>
                    <p className="text-[11.5px] text-ink-muted">
                        Read live from the database{checked ? ` · checked at ${checked}` : ''}
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {head && (
                        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', style.pill)}>
                            <span className="relative flex h-2 w-2">
                                {tone !== 'good' && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', style.dot)} />}
                                <span className={cn('relative inline-flex h-2 w-2 rounded-full', style.dot)} />
                            </span>
                            {head.label}
                        </span>
                    )}
                    <button type="button" onClick={() => refetch()} disabled={isFetching} aria-label="Check the schema again"
                        className="rounded-lg border border-glass-border p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 disabled:opacity-60 transition-colors">
                        <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
                    </button>
                </div>
            </div>

            {isLoading && <Skeleton />}

            {error && !data && (
                <div className="mt-4 flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
                    <XCircle className="h-5 w-5 shrink-0 text-rose-500" />
                    <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-ink">Couldn’t read the schema</p>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{error instanceof Error ? error.message : String(error)}</p>
                    </div>
                </div>
            )}

            {data && head && (
                <div className="mt-5 space-y-4">
                    {/* Verdict */}
                    <div className={cn('flex items-start gap-3 rounded-xl border bg-gradient-to-r to-transparent p-4', style.banner)}>
                        <BannerIcon className={cn('mt-0.5 h-5 w-5 shrink-0',
                            tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-rose-500')} />
                        <div className="min-w-0">
                            <p className="text-[14px] font-semibold text-ink">{head.title}</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted break-words">{sentence}</p>
                        </div>
                    </div>

                    {/* At a glance */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                        <StatCard icon={Layers} label="Applied" accent="from-indigo-500/[0.10]">
                            {data.applied.length ? data.applied.map((id) => <Revision key={id} id={id} strong />)
                                : <span className="text-[13px] text-ink-muted">Nothing yet</span>}
                        </StatCard>
                        <StatCard icon={GitBranch} label="This build’s head" accent="from-violet-500/[0.10]">
                            {data.expected.map((id) => <Revision key={id} id={id} strong />)}
                        </StatCard>
                        <StatCard icon={ListOrdered} label="Pending"
                            accent={data.plan.verdict === 'refused' ? 'from-rose-500/[0.12]'
                                : data.plan.wouldRun.length ? 'from-amber-500/[0.12]' : 'from-emerald-500/[0.10]'}>
                            {data.plan.verdict === 'refused' ? (
                                <>
                                    <div className="text-3xl font-bold tracking-tight text-rose-600 dark:text-rose-400">—</div>
                                    <div className="text-[11.5px] text-ink-muted">until the database is placed on this chain</div>
                                </>
                            ) : (
                                <>
                                    <div className="text-3xl font-bold tracking-tight text-ink tabular-nums">{data.plan.wouldRun.length}</div>
                                    <div className="text-[11.5px] text-ink-muted">
                                        {data.plan.wouldRun.length === 1 ? 'migration to run' : 'migrations to run'}
                                    </div>
                                </>
                            )}
                        </StatCard>
                        <StatCard icon={Server} label="This server" accent="from-sky-500/[0.10]">
                            <div className="font-mono text-[12px] font-semibold text-ink truncate" title={data.build.from}>{data.build.from}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                                {data.build.version && <span>v{data.build.version}</span>}
                                <span className={cn('rounded-full border px-1.5 py-px text-[10px] font-medium',
                                    data.build.onMain === true ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                        : data.build.onMain === false ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                            : 'border-glass-border text-ink-muted')}>
                                    {data.build.onMain === true ? 'on main' : data.build.onMain === false ? 'not on main' : 'source unrecorded'}
                                </span>
                            </div>
                        </StatCard>
                    </div>

                    {/* Where another build's stamp goes */}
                    {data.plan.placement && (
                        <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.05] p-4">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
                                Stamped by another build
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {data.plan.placement.foreign.map((id) => <Chip key={id} tone="amber">{id}</Chip>)}
                                <ArrowRight className="h-4 w-4 text-ink-muted" aria-label="placed at" />
                                {data.plan.placement.stamps.map((id) => <Chip key={id} tone="indigo">{id}</Chip>)}
                                <ArrowRight className="h-4 w-4 text-ink-muted" aria-label="then upgraded to" />
                                {data.expected.map((id) => <Chip key={id} tone="emerald">{id}</Chip>)}
                            </div>
                            <p className="mt-2 text-[11.5px] text-ink-muted">Placed {data.plan.placement.how}.</p>
                        </div>
                    )}

                    {/* What would run */}
                    {data.plan.wouldRun.length > 0 && (
                        <div className="rounded-xl border border-glass-border bg-canvas-overlay/40 p-4">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">In the order they would run</p>
                            <ol className="mt-3 space-y-2">
                                {(allPending ? data.plan.wouldRun : data.plan.wouldRun.slice(0, PENDING_SHOWN)).map((id, i) => {
                                    const { name, written } = readRevision(id)
                                    return (
                                        <li key={id} className="group flex items-center gap-3">
                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/20 to-violet-500/20 text-[10.5px] font-semibold tabular-nums text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-500/25">
                                                {i + 1}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-2 min-w-0">
                                                    <span className="truncate text-[12.5px] text-ink">{name}</span>
                                                    {written && <span className="shrink-0 text-[10.5px] text-ink-muted/80">{written}</span>}
                                                </div>
                                                <div className="flex items-center gap-1 min-w-0">
                                                    <span className="truncate font-mono text-[10.5px] text-ink-muted">{id}</span>
                                                    <CopyId id={id} />
                                                </div>
                                            </div>
                                        </li>
                                    )
                                })}
                            </ol>
                            {data.plan.wouldRun.length > PENDING_SHOWN && (
                                <button type="button" onClick={() => setAllPending((v) => !v)}
                                    className="mt-3 text-[11.5px] font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                                    {allPending ? 'Show fewer' : `Show all ${data.plan.wouldRun.length}`}
                                </button>
                            )}
                        </div>
                    )}

                    {data.plan.warnings.map((w) => (
                        <Callout key={w} tone="amber" icon={AlertTriangle}>{w}</Callout>
                    ))}

                    {notGranted.length > 0 && (
                        <Callout tone="violet" icon={KeyRound}>
                            <p className="font-medium text-ink">Built-in grants this database doesn’t have</p>
                            <p className="mt-0.5 text-ink-muted">
                                Left as they are: an admin may have removed them. Admin → Permissions → Reset to default restores a role’s.
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {notGranted.map((g) => <Chip key={g} tone="indigo">{g}</Chip>)}
                            </div>
                        </Callout>
                    )}

                    {/* History */}
                    {data.history.length > 0 && (
                        <div>
                            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">What upgrades have done</p>
                            <ol>
                                {(allHistory ? data.history : data.history.slice(0, HISTORY_SHOWN)).map((h, i, shown) => (
                                    <HistoryItem key={h.id} h={h} last={i === shown.length - 1} />
                                ))}
                            </ol>
                            {data.history.length > HISTORY_SHOWN && (
                                <button type="button" onClick={() => setAllHistory((v) => !v)}
                                    className="text-[11.5px] font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                                    {allHistory ? 'Show fewer' : `Show the last ${data.history.length}`}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </section>
    )
}
