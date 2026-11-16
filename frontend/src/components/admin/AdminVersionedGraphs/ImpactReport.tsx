/**
 * ImpactReport — the full preview of a change, drawn for the review: which graphs behave
 * differently, readers moving to or from the database, the memory a copy needs on each node, what
 * the next memory check unloads and loads, the most reads on the database, drafts that lose their
 * changes, and values left outside new limits.
 *
 * Every part is the server's, and best effort: a part it couldn't work out is named as such, never
 * drawn as zero. A part the change can't affect isn't drawn at all.
 */
import type { ReactNode } from 'react'
import { ArrowRight, Check, Database, GitBranch, Layers, MemoryStick, Network, Ruler, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount } from '@/lib/units'
import { formatValue, type Setting, type SettingValue } from '@/components/settings'
import type { Impact } from '@/services/settingsService'

const PART_NAME: Record<string, string> = {
    graphs: 'which graphs behave differently',
    alwaysLatest: 'readers moving to or from the database',
    memory: 'the memory a copy needs',
    residency: 'what the next memory check does',
    database: 'reads on the database',
    drafts: 'drafts that lose their changes',
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`

function Tile({ icon: Icon, figure, title, children, tone = 'neutral' }: {
    icon: typeof Network
    figure: ReactNode
    title: ReactNode
    children?: ReactNode
    tone?: 'neutral' | 'warning'
}) {
    return (
        <li className={cn('rounded-xl border px-4 py-3', tone === 'warning' ? 'border-amber-500/25 bg-amber-500/[0.05]' : 'border-glass-border/60 bg-black/[0.015] dark:bg-white/[0.02]')}>
            <div className="flex items-start gap-3">
                <Icon aria-hidden className="mt-1 w-4 h-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold leading-tight tracking-tight text-ink">{figure}</p>
                    <p className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{title}</p>
                    {children && <div className="mt-2 text-[11.5px] text-ink-secondary">{children}</div>}
                </div>
            </div>
        </li>
    )
}

/** "Always the latest → Keep serving, update in place", wrapping as text does. */
function Moved({ s, from, to }: { s?: Setting; from: SettingValue; to: SettingValue }) {
    const say = (v: SettingValue) => (s ? formatValue(s, v) : String(v))
    return (
        <span>
            {say(from)} <ArrowRight aria-hidden className="inline w-3 h-3 -mt-0.5" /><span className="sr-only">to</span>{' '}
            <span className="font-medium text-ink">{say(to)}</span>
        </span>
    )
}

export function ImpactReport({ impact, settings }: { impact: Impact; settings: Record<string, Setting> }) {
    const tiles: ReactNode[] = []
    const { graphs, alwaysLatest, memory, residency, database, drafts, outsideLimits } = impact

    if (graphs) {
        tiles.push(
            <Tile key="graphs" icon={Network}
                figure={graphs.changed === 0 ? 'No graph' : `${formatCount(graphs.changed)} of ${formatCount(graphs.inScope)}`}
                title={graphs.changed === 0 ? `behaves differently, of ${plural(graphs.inScope, 'graph')} it reaches.` : `${graphs.inScope === 1 ? 'graph behaves' : 'graphs behave'} differently.`}>
                {graphs.samples.length > 0 && (
                    <ul className="space-y-1">
                        {graphs.samples.map((g) => (
                            <li key={g.graphId}>
                                <span className="font-medium text-ink">{g.label ?? g.graphId}</span>
                                {g.changes.map((c) => (
                                    <span key={c.key} className="block">
                                        {settings[c.key]?.label ?? c.key}: <Moved s={settings[c.key]} from={c.from} to={c.to} />
                                    </span>
                                ))}
                            </li>
                        ))}
                        {graphs.changed > graphs.samples.length && <li>and {plural(graphs.changed - graphs.samples.length, 'more graph')}.</li>}
                    </ul>
                )}
            </Tile>,
        )
    }
    if (alwaysLatest && (alwaysLatest.joining || alwaysLatest.leaving)) {
        tiles.push(
            <Tile key="readers" icon={Database}
                figure={alwaysLatest.joining ? plural(alwaysLatest.joining, 'graph') : plural(alwaysLatest.leaving, 'graph')}
                title={alwaysLatest.joining
                    ? 'move to Always the latest: while the graph store catches up after a publish, their readers read from the database.'
                    : 'move away from Always the latest: readers stay on the graph store while it updates.'}>
                {alwaysLatest.joining > 0 && alwaysLatest.leaving > 0 && <p>{plural(alwaysLatest.leaving, 'graph')} move away from it.</p>}
            </Tile>,
        )
    }
    if (memory) {
        const fits = memory.nodes.filter((n) => n.fits).length
        const same = memory.neededBytes.from === memory.neededBytes.to
        tiles.push(
            <Tile key="memory" icon={MemoryStick} tone={memory.copied && memory.nodes.length > 0 && fits === 0 ? 'warning' : 'neutral'}
                figure={same ? formatBytes(memory.neededBytes.to) : <Moved from={formatBytes(memory.neededBytes.from)} to={formatBytes(memory.neededBytes.to)} />}
                title={`needed free on one node to copy your largest graph (${formatBytes(memory.largestGraphBytes)})${memory.copied ? '' : ': it is built from the database instead, as it isn’t copied'}.`}>
                {memory.nodes.length > 0 && (
                    <ul className="space-y-0.5">
                        {memory.nodes.map((n, i) => (
                            <li key={n.name ?? i} className="flex items-start gap-1.5">
                                {n.fits
                                    ? <Check aria-hidden className="mt-0.5 w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                    : <X aria-hidden className="mt-0.5 w-3 h-3 shrink-0 text-amber-600 dark:text-amber-400" />}
                                {/* Free under its start mark, or already over it: never clamped to nothing. */}
                                <span className="min-w-0">
                                    <span className="font-mono text-[10.5px]">{n.name ?? `Node ${i + 1}`}</span>{' '}
                                    {n.freeBytes >= 0
                                        ? `has ${formatBytes(n.freeBytes)} free under its start mark`
                                        : `is ${formatBytes(-n.freeBytes)} over its start mark already`}
                                    {n.fits ? ': enough' : ': not enough'}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Tile>,
        )
    }
    if (residency) {
        tiles.push(
            <Tile key="residency" icon={Layers} tone={residency.unloads > 0 && residency.switchOn ? 'warning' : 'neutral'}
                figure={residency.unloads ? `${plural(residency.unloads, 'graph')} unloaded` : 'Nothing unloaded'}
                title={`at the next memory check${residency.unloads ? ` (${formatBytes(residency.unloadedBytes)})` : ''}; ${plural(residency.loads, 'graph')} loaded, ${plural(residency.waits, 'graph')} waiting for room.${residency.switchOn ? '' : ' Graph residency is off, so nothing acts on this until it is on.'}`}>
                {residency.nodes.some((n) => n.unloads.length || n.loads.length || n.waits.length) && (
                    <ul className="space-y-0.5">
                        {residency.nodes.map((n) => (
                            <li key={n.name}>
                                <span className="font-mono text-[10.5px]">{n.name}</span>: {formatBytes(n.usedBytes)} → {formatBytes(n.usedAfterBytes)}
                                {n.unloads.length > 0 && ` · unloads ${n.unloads.map((u) => u.label ?? 'a graph').join(', ')}`}
                            </li>
                        ))}
                    </ul>
                )}
            </Tile>,
        )
    }
    if (database) {
        const s = (k: string) => settings[`database.${k}`]
        const rows = (['readsPerProcess', 'readsPerGraph', 'readTimeoutMs'] as const).filter((k) => database[k])
        tiles.push(
            <Tile key="database" icon={Database}
                figure={database.readsPerProcess ? <Moved s={s('readsPerProcess')} from={database.readsPerProcess.from} to={database.readsPerProcess.to} /> : 'Reads on the database'}
                title={`at once per process, at most${database.poolSize ? `, of the ${formatCount(database.poolSize)} connections each keeps` : ''}.`}>
                <ul className="space-y-0.5">
                    {rows.filter((k) => k !== 'readsPerProcess').map((k) => (
                        <li key={k}>{s(k)?.label ?? k}: <Moved s={s(k)} from={database[k]!.from} to={database[k]!.to} /></li>
                    ))}
                </ul>
            </Tile>,
        )
    }
    if (drafts) {
        tiles.push(
            <Tile key="drafts" icon={GitBranch} tone={drafts.removedAtNextSweep > 0 ? 'warning' : 'neutral'}
                figure={drafts.removedAtNextSweep ? plural(drafts.removedAtNextSweep, 'closed draft') : 'No draft'}
                title={drafts.removedAtNextSweep
                    ? `${drafts.removedAtNextSweep === 1 ? 'loses its' : 'lose their'} changes at the next sweep, in ${plural(drafts.workspaces, 'workspace')}. The drafts’ records stay.`
                    : 'loses its changes at the next sweep.'} />,
        )
    }
    if (outsideLimits && outsideLimits.count > 0) {
        const where = (scope: string, id: string) => `${scope === 'workspace' ? 'Workspace' : scope === 'graph' ? 'Graph' : scope} ${id}`
        tiles.push(
            <Tile key="limits" icon={Ruler} tone="warning"
                figure={plural(outsideLimits.count, 'value')}
                title={`chosen for workspaces and graphs ${outsideLimits.count === 1 ? 'is' : 'are'} outside the new limits${outsideLimits.locked ? `; ${formatCount(outsideLimits.locked)} ignored while it is locked` : ''}.`}>
                {outsideLimits.samples.length > 0 && (
                    <ul className="space-y-0.5">
                        {outsideLimits.samples.map((v) => (
                            <li key={`${v.key}:${v.scope}:${v.scopeId}`}>
                                <span className="font-medium text-ink">{where(v.scope, v.scopeId)}</span>: {settings[v.key]?.label ?? v.key}{' '}
                                {settings[v.key] ? formatValue(settings[v.key], v.value) : String(v.value)}
                                {v.status === 'locked' ? ', ignored while it is locked' : ', kept as an exception'}
                            </li>
                        ))}
                        {outsideLimits.count > outsideLimits.samples.length && <li>and {plural(outsideLimits.count - outsideLimits.samples.length, 'more value')}.</li>}
                    </ul>
                )}
            </Tile>,
        )
    }

    return (
        <div className="space-y-2">
            {tiles.length > 0
                ? <ul className="grid gap-2 sm:grid-cols-2">{tiles}</ul>
                : impact.unavailable.length === 0 && <p className="text-[13px] text-ink-secondary">Nothing else changes: no graph behaves differently.</p>}
            {impact.unavailable.length > 0 && (
                <p className="flex items-start gap-1.5 text-[11.5px] text-ink-secondary">
                    <TriangleAlert aria-hidden className="mt-0.5 w-3 h-3 shrink-0" />
                    Couldn’t work out {impact.unavailable.map((p) => PART_NAME[p] ?? p).join(', ')} just now. The rest is above; saving checks the values again.
                </p>
            )}
        </div>
    )
}
