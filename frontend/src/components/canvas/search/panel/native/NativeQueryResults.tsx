/**
 * NativeQueryResults — what a native query answered: a table of its columns
 * and rows, each value as it is — a node, edge or path as a chip that opens
 * to its properties, a map or list that opens to its entries — and a footer
 * saying when the answer was cut, and why.
 */
import { ArrowRight, Box, GitCommitHorizontal, Route } from 'lucide-react'
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'
import type { NativeQueryResponse } from '@/types/search'

import { cellText, type EdgeCell, type NativeCell, type NodeCell } from './nativeCells'


export const NativeQueryResults: FC<{ answer: NativeQueryResponse }> = ({ answer }) => {
    const rows = answer.rows as NativeCell[][]
    return (
        <div className="rounded-xl border border-glass-border/60 bg-canvas-base/40 overflow-hidden">
            {answer.columns.length === 0 || rows.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-ink-muted">No rows.</p>
            ) : (
                <div className="max-h-80 overflow-auto custom-scrollbar">
                    <table className="w-full border-collapse text-[11.5px]" aria-label="Query results">
                        <thead className="sticky top-0 z-[1] bg-canvas-base">
                            <tr>
                                {answer.columns.map((column, i) => (
                                    <th
                                        key={`${column}-${i}`}
                                        scope="col"
                                        className={cn(
                                            'px-2.5 py-1.5 text-left font-semibold text-ink-muted',
                                            'border-b border-glass-border/60 font-mono whitespace-nowrap',
                                        )}
                                    >
                                        {column}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, i) => (
                                <tr key={i} className="border-b border-glass-border/25 last:border-b-0 align-top">
                                    {row.map((cell, j) => (
                                        <td key={j} className="px-2.5 py-1.5 max-w-[22rem]">
                                            <Cell cell={cell} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <Footer answer={answer} />
        </div>
    )
}


function Footer({ answer }: { answer: NativeQueryResponse }) {
    const rows = `${answer.rowCount.toLocaleString()} row${answer.rowCount === 1 ? '' : 's'}`
    let cut: string | null = null
    if (answer.truncatedReason === 'rows') {
        cut = `More rows matched — these are the first ${answer.rowCount.toLocaleString()}. Raise the row limit, or narrow the query.`
    } else if (answer.truncatedReason === 'size') {
        cut = 'The answer was too large to show whole — return fewer rows, or properties instead of whole nodes.'
    }
    return (
        <div className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2',
            'border-t border-glass-border/40 text-[10.5px] text-ink-muted',
        )}>
            <span className="tabular-nums">{rows} · {answer.elapsedMs.toLocaleString()} ms · {answer.engine === 'neo4j' ? 'Neo4j' : 'FalkorDB'}</span>
            {cut && <span className="text-amber-700 dark:text-amber-300">{cut}</span>}
        </div>
    )
}


/** One value. */
export function Cell({ cell }: { cell: NativeCell }) {
    if (cell === null) return <span className="italic text-ink-muted/80">null</span>
    if (typeof cell === 'string') return <span className="break-words whitespace-pre-wrap">{cell}</span>
    if (typeof cell !== 'object') return <span className="font-mono tabular-nums">{String(cell)}</span>
    switch (cell.kind) {
        case 'node':
            return <NodeChip node={cell} />
        case 'edge':
            return <EdgeChip edge={cell} />
        case 'path':
            return (
                <Disclosure
                    icon={<Route className="w-3 h-3" />}
                    label={cell.nodes.map((n) => n.displayName ?? n.urn ?? n.id).join(' → ')}
                    tone="teal"
                >
                    <div className="flex flex-col gap-1">
                        {cell.nodes.map((node, i) => (
                            <div key={`${node.id}-${i}`} className="flex items-center gap-1 flex-wrap">
                                <NodeChip node={node} />
                                {cell.edges[i] && <EdgeChip edge={cell.edges[i]} />}
                            </div>
                        ))}
                        {cell.truncated && <More size={cell.size} shown={cell.edges.length} noun="steps" />}
                    </div>
                </Disclosure>
            )
        case 'map':
            return (
                <Disclosure label={cellText(cell)} tone="slate">
                    <Properties entries={cell.entries} />
                    {cell.truncated && <More size={cell.size} shown={Object.keys(cell.entries).length} noun="entries" />}
                </Disclosure>
            )
        case 'list':
            if (cell.items.every((item) => item === null || typeof item !== 'object') && cell.items.length <= 8) {
                return <span className="font-mono break-words">{cellText(cell)}</span>
            }
            return (
                <Disclosure label={`${cell.size ?? cell.items.length} items`} tone="slate">
                    <ol className="flex flex-col gap-0.5 list-decimal pl-4">
                        {cell.items.map((item, i) => <li key={i}><Cell cell={item} /></li>)}
                    </ol>
                    {cell.truncated && <More size={cell.size} shown={cell.items.length} noun="items" />}
                </Disclosure>
            )
        case 'string':
            return (
                <span className="break-words whitespace-pre-wrap" title={`${cell.length.toLocaleString()} characters`}>
                    {cell.text}<span className="text-ink-muted">…</span>
                </span>
            )
        default:
            return <span className="font-mono text-ink/90">{cellText(cell)}</span>
    }
}


function NodeChip({ node }: { node: NodeCell }) {
    return (
        <Disclosure
            icon={<Box className="w-3 h-3" />}
            label={node.displayName ?? node.urn ?? node.id}
            badge={node.labels.join(':') || undefined}
            tone="indigo"
        >
            {node.urn && <p className="font-mono text-[10.5px] text-ink-muted break-all">{node.urn}</p>}
            <Properties entries={node.properties} />
            {node.truncated && <p className="text-[10.5px] text-ink-muted">More properties than are shown.</p>}
        </Disclosure>
    )
}


function EdgeChip({ edge }: { edge: EdgeCell }) {
    return (
        <Disclosure
            icon={<GitCommitHorizontal className="w-3 h-3" />}
            label={edge.type}
            tone="amber"
        >
            <p className="flex items-center gap-1 font-mono text-[10.5px] text-ink-muted">
                {edge.start} <ArrowRight className="w-3 h-3" /> {edge.end}
            </p>
            <Properties entries={edge.properties} />
        </Disclosure>
    )
}


function Properties({ entries }: { entries: Record<string, NativeCell> }) {
    const keys = Object.keys(entries)
    if (keys.length === 0) return <p className="text-[10.5px] text-ink-muted">No properties.</p>
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {keys.map((key) => (
                <div key={key} className="contents">
                    <dt className="font-mono text-[10.5px] text-ink-muted">{key}</dt>
                    <dd className="min-w-0"><Cell cell={entries[key]} /></dd>
                </div>
            ))}
        </dl>
    )
}


function More({ size, shown, noun }: { size?: number; shown: number; noun: string }) {
    return (
        <p className="text-[10.5px] text-ink-muted">
            {size ? `${(size - shown).toLocaleString()} more ${noun} not shown.` : `More ${noun} than are shown.`}
        </p>
    )
}


const TONES = {
    indigo: 'border-indigo-500/30 bg-indigo-500/[0.07] text-indigo-700 dark:text-indigo-300',
    amber: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300',
    teal: 'border-teal-500/30 bg-teal-500/[0.07] text-teal-800 dark:text-teal-300',
    slate: 'border-glass-border/60 bg-glass/30 text-ink/90',
} as const


/** A chip that opens to what it holds. */
function Disclosure({ icon, label, badge, tone, children }: {
    icon?: ReactNode
    label: string
    badge?: string
    tone: keyof typeof TONES
    children: ReactNode
}) {
    return (
        <details className="group inline-block max-w-full align-top">
            <summary
                className={cn(
                    'inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded-md border cursor-pointer',
                    'list-none [&::-webkit-details-marker]:hidden text-[11px] select-none',
                    TONES[tone],
                )}
            >
                {icon}
                {badge && <span className="font-mono text-[9.5px] opacity-75">{badge}</span>}
                <span className="truncate">{label}</span>
            </summary>
            <div className="mt-1 ml-1 pl-2 border-l border-glass-border/50 flex flex-col gap-1">
                {children}
            </div>
        </details>
    )
}
