/**
 * SchemaPanel — the database schema: where it stands against this server's migrations, what an
 * upgrade with this build would do (the upgrade Job's own decision, `synodic-upgrade plan`), and
 * what upgrades have done to it (alembic_history).
 *
 * Read live by the server on each poll, not from the startup snapshot the Viz Service tile's
 * `schemaAtHead` comes from.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SchemaHistoryEntry, SchemaStatus } from '@/services/systemStatusService'
import { formatSince } from './meta'
import { useSchemaStatus } from './useSchemaStatus'

type Tone = 'good' | 'warn' | 'bad'

const TONE: Record<Tone, string> = {
    good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    bad: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

/** What the page says first: whether anything needs doing. */
export function schemaHeadline(status: SchemaStatus): { label: string; tone: Tone } {
    const { plan } = status
    if (plan.verdict === 'refused') return { label: 'Needs attention', tone: 'bad' }
    if (plan.verdict === 'fresh_install') return { label: 'Not installed', tone: 'warn' }
    if (plan.verdict === 'upgrade') {
        const n = plan.wouldRun.length
        return { label: n ? `${n} migration${n === 1 ? '' : 's'} pending` : 'Upgrade pending', tone: 'warn' }
    }
    return plan.warnings.length ? { label: 'Up to date, with warnings', tone: 'warn' } : { label: 'Up to date', tone: 'good' }
}

const KIND_TONE: Record<string, string> = {
    ran: 'text-emerald-600 dark:text-emerald-400',
    stamped: 'text-ink-muted',
    verified: 'text-emerald-600 dark:text-emerald-400',
    placed: 'text-indigo-600 dark:text-indigo-400',
    seeded: 'text-indigo-600 dark:text-indigo-400',
    changed: 'text-amber-600 dark:text-amber-400',
    restored: 'text-rose-600 dark:text-rose-400',
    downgraded: 'text-rose-600 dark:text-rose-400',
}

function Revisions({ ids }: { ids: string[] }) {
    if (!ids.length) return <span className="text-ink-muted">none</span>
    return <span className="font-mono text-[11px] break-all">{ids.join(', ')}</span>
}

function HistoryRow({ h }: { h: SchemaHistoryEntry }) {
    return (
        <tr className="border-t border-glass-border/60">
            <td className={cn('py-1 pr-3 text-[11px] font-medium', KIND_TONE[h.kind] ?? 'text-ink')}>{h.kind}</td>
            <td className="py-1 pr-3 font-mono text-[11px] text-ink break-all">{h.revision}</td>
            <td className="py-1 pr-3 text-[11px] text-ink-muted whitespace-nowrap" title={h.at ?? undefined}>
                {formatSince(h.at) ?? '—'}
            </td>
            <td className="py-1 text-[11px] text-ink-muted font-mono break-all">{h.build ?? ''}</td>
        </tr>
    )
}

export function SchemaPanel() {
    const { data, error, isLoading } = useSchemaStatus()
    const [allHistory, setAllHistory] = useState(false)
    const [allPending, setAllPending] = useState(false)

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5" aria-label="Database schema">
            <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">Database schema</h3>
                {data && (() => {
                    const head = schemaHeadline(data)
                    return (
                        <span className={cn('ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE[head.tone])}>
                            {head.label}
                        </span>
                    )
                })()}
            </div>

            {isLoading && (
                <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-muted">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the schema…
                </p>
            )}
            {error && !data && (
                <p className="mt-3 text-[12px] text-rose-500">
                    Couldn’t read the schema: {error instanceof Error ? error.message : String(error)}
                </p>
            )}

            {data && (
                <div className="mt-3 space-y-3 text-[12px] text-ink">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                        <dt className="text-ink-muted">Applied</dt>
                        <dd><Revisions ids={data.applied} /></dd>
                        <dt className="text-ink-muted">This build’s head</dt>
                        <dd><Revisions ids={data.expected} /></dd>
                        <dt className="text-ink-muted">This server</dt>
                        <dd>
                            <span className="font-mono text-[11px]">{data.build.from}</span>
                            {data.build.version && <span className="text-ink-muted"> · v{data.build.version}</span>}
                            <span className="text-ink-muted">
                                {' · '}
                                {data.build.onMain === true ? 'on main' : data.build.onMain === false ? 'not on main' : 'source unrecorded'}
                            </span>
                        </dd>
                    </dl>

                    <div className="rounded-xl border border-glass-border bg-canvas-overlay/40 px-3 py-2.5">
                        <p className="flex items-start gap-2">
                            {data.plan.verdict === 'refused'
                                ? <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-rose-500 shrink-0" />
                                : <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-ink-muted shrink-0" />}
                            <span>
                                <span className="font-medium">An upgrade with this build: </span>
                                {data.plan.reason}
                            </span>
                        </p>
                        {data.plan.placement && (
                            <p className="mt-1.5 text-ink-muted">
                                Stamped by another build (<Revisions ids={data.plan.placement.foreign} />): placed at{' '}
                                <Revisions ids={data.plan.placement.stamps} />, {data.plan.placement.how}.
                            </p>
                        )}
                        {data.plan.wouldRun.length > 0 && (
                            <ol className="mt-1.5 list-decimal pl-5 font-mono text-[11px] text-ink-muted">
                                {(allPending ? data.plan.wouldRun : data.plan.wouldRun.slice(0, 8)).map((r) => (
                                    <li key={r}>{r}</li>
                                ))}
                            </ol>
                        )}
                        {data.plan.wouldRun.length > 8 && (
                            <button type="button" className="mt-1 text-[11px] text-indigo-500 hover:underline"
                                onClick={() => setAllPending((v) => !v)}>
                                {allPending ? 'Show fewer' : `Show all ${data.plan.wouldRun.length}`}
                            </button>
                        )}
                    </div>

                    {data.plan.warnings.map((w) => (
                        <p key={w} className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {w}
                        </p>
                    ))}

                    {Array.isArray(data.lastSeeded?.detail?.notGranted) && (data.lastSeeded!.detail!.notGranted as string[]).length > 0 && (
                        <p className="text-ink-muted">
                            Built-in grants this database doesn’t have, left as they are (an admin may have removed them):{' '}
                            <span className="font-mono text-[11px]">{(data.lastSeeded!.detail!.notGranted as string[]).join(', ')}</span>.
                            Admin → Permissions → Reset to default restores a role’s.
                        </p>
                    )}

                    {data.history.length > 0 && (
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">What upgrades have done</p>
                            <table className="mt-1 w-full text-left">
                                <tbody>
                                    {(allHistory ? data.history : data.history.slice(0, 10)).map((h) => (
                                        <HistoryRow key={h.id} h={h} />
                                    ))}
                                </tbody>
                            </table>
                            {data.history.length > 10 && (
                                <button type="button" className="mt-1 text-[11px] text-indigo-500 hover:underline"
                                    onClick={() => setAllHistory((v) => !v)}>
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
