/**
 * ExportMatchesDialog — every match of the search, written to a file.
 *
 * Every one, however many: the server reads the view a slice at a time and
 * writes each match once (``services/searchExport``), so a million matches
 * export as exactly as ten. Values are written as the graph keeps them — a
 * 64-bit integer keeps its digits, a list stays a list.
 *
 * Choose the format and which properties become columns — the view's own
 * properties, from its exact catalog, each with how many entities carry it
 * — then watch the rows being written. The file downloads when it is ready,
 * and again from here for as long as the dialog is open.
 *
 * A Connections search exports its edges instead: each edge's fixed columns
 * — the edge, each end and each end's parent, its properties as JSON — and
 * the edge properties chosen, from what discovery found on its edge types.
 *
 * Portal-mounted (mirrors LibraryImportDialog) so the fixed overlay resolves
 * to the viewport, not to the search panel's framer-motion transform.
 */
import { motion } from 'framer-motion'
import { Check, Download, FileDown, Plus, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import { followExport } from '@/services/searchExport'
import type { SearchExportResult, SearchQuery } from '@/types/search'

import { useDiscovery } from '../builder/useDiscovery'
import { edgeTypeName } from './vocabulary/edgeWords'


export interface ExportMatchesDialogProps {
    viewId: string
    /** The search whose matches to export: its predicate and scope. */
    query: SearchQuery
    /** How many matches the search found, when it has counted them. */
    matchCount: number | null
    onClose: () => void
}


type Format = 'csv' | 'ndjson'

const FORMATS: ReadonlyArray<{ value: Format; label: string; description: string }> = [
    { value: 'csv', label: 'CSV', description: 'Opens in any spreadsheet.' },
    { value: 'ndjson', label: 'NDJSON', description: 'One JSON object a line — lists and numbers stay as they are.' },
]

/** Columns every row starts with. */
const BASE_COLUMNS = ['URN', 'Name', 'Type', 'Qualified name']

/** A Connections export's fixed columns, as the server writes them
 *  (``SEARCH_EXPORT_EDGE_COLUMNS``): each end is its URN, name and type. */
const EDGE_BASE_COLUMNS = ['Edge key', 'Edge ID', 'Edge type', 'Source', 'Source parent', 'Target',
    'Target parent', 'Properties (JSON)']
const EDGE_FIXED_COLUMNS = 14

/** The most properties an export takes as columns (the server's limit). */
const MAX_COLUMNS = 200

/** Properties listed at once; typing narrows the rest. */
const SHOWN = 150


type Phase =
    | { kind: 'choose' }
    | { kind: 'exporting'; answer: SearchExportResult | null }
    | { kind: 'ready'; answer: SearchExportResult; url: string }
    | { kind: 'failed'; message: string }


export function ExportMatchesDialog({ viewId, query, matchCount, onClose }: ExportMatchesDialogProps) {
    const provider = useGraphProvider()
    // A Connections search exports edges: its columns are edge properties,
    // which discovery knows; the view's property catalog isn't read.
    const connections = query.predicate.kind === 'edges' ? query.predicate : null
    const { catalog, reading, unavailable } = usePropertyCatalog(connections ? '' : viewId)
    const edgeKeys = useEdgeKeys(connections ? viewId : null, connections?.edgeTypes ?? null)
    const [format, setFormat] = useState<Format>('csv')
    const [withDescription, setWithDescription] = useState(true)
    const [withTags, setWithTags] = useState(true)
    const [chosen, setChosen] = useState<string[]>([])
    const [filter, setFilter] = useState('')
    const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
    const running = useRef<AbortController | null>(null)

    // Closing stops following the export; what the server wrote so far it
    // keeps a while, and the same export asked again picks it up.
    useEffect(() => () => running.current?.abort(), [])

    const columns = useMemo(() => (connections ? chosen : [
        ...(withDescription ? ['description'] : []),
        ...(withTags ? ['tags'] : []),
        ...chosen,
    ]), [connections, withDescription, withTags, chosen])
    const full = columns.length >= MAX_COLUMNS
    const baseColumns = connections ? EDGE_BASE_COLUMNS : BASE_COLUMNS
    const fixedColumns = connections ? EDGE_FIXED_COLUMNS : BASE_COLUMNS.length
    const noun = connections ? ['connection', 'connections'] as const : ['match', 'matches'] as const

    // What can become a column, with how widely it is set: a property and
    // the entities carrying it, or an edge property and its edge types.
    const choices = useMemo<Array<{ key: string; note: string; weight: number }>>(() => (connections
        ? edgeKeys.map((k) => ({ key: k.key, note: onEdgeTypes(k.types), weight: k.types.length }))
        : (catalog?.properties ?? []).map((p) => ({
            key: p.key, weight: p.count,
            note: catalog?.entities
                ? `on ${p.count.toLocaleString()} of ${catalog.entities.toLocaleString()}`
                : `on ${p.count.toLocaleString()}`,
        }))), [connections, edgeKeys, catalog])
    const listed = useMemo(() => new Set(choices.map((p) => p.key)), [choices])
    const properties = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        return choices
            .filter((p) => !needle || p.key.toLowerCase().includes(needle))
            .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
    }, [choices, filter])
    // Chosen by name: not one the catalog lists (so shown whatever the filter).
    const byName = chosen.filter((k) => !listed.has(k))
    const typed = filter.trim()
    const canAddTyped = typed !== '' && !chosen.includes(typed) && !listed.has(typed)

    const toggle = (key: string) => setChosen((c) => (
        c.includes(key) ? c.filter((k) => k !== key) : full ? c : [...c, key]))

    const start = () => {
        if (!(provider instanceof RemoteGraphProvider)) return
        const controller = new AbortController()
        running.current = controller
        setPhase({ kind: 'exporting', answer: null })
        followExport(provider, {
            scope: query.scope, predicate: query.predicate, format, columns,
        }, {
            signal: controller.signal,
            onUpdate: (answer) => {
                if (!controller.signal.aborted && answer.status === 'running') {
                    setPhase({ kind: 'exporting', answer })
                }
            },
        }).then((answer) => {
            if (controller.signal.aborted) return
            if (!answer.downloadToken) {
                setPhase({ kind: 'failed', message: 'The export finished without a download link — export again.' })
                return
            }
            const url = provider.searchExportDownloadUrl(answer.sessionId, answer.downloadToken)
            setPhase({ kind: 'ready', answer, url })
            triggerBrowserDownload(url, answer.filename ?? `search-export.${answer.format}`)
        }).catch((e: unknown) => {
            if (controller.signal.aborted) return
            setPhase({ kind: 'failed', message: failureMessage(e) })
        })
    }

    const stop = () => {
        running.current?.abort()
        setPhase({ kind: 'choose' })
    }

    if (typeof document === 'undefined') return null
    return createPortal(
        <>
        <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
                className={cn(
                    'pointer-events-auto relative w-full max-w-lg rounded-2xl overflow-hidden flex flex-col',
                    'max-h-[88vh]',
                    'bg-canvas-elevated',
                    'border border-slate-200 dark:border-glass-border',
                    'shadow-2xl shadow-black/40',
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-matches-title"
            >
                {/* Header */}
                <div className={cn(
                    'flex items-center gap-3 px-5 py-4 shrink-0',
                    'border-b border-slate-200 dark:border-glass-border',
                )}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-accent-lineage/15">
                        <FileDown className="w-5 h-5 text-accent-lineage" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 id="export-matches-title" className="text-[15px] font-display font-bold text-ink leading-tight">
                            Export {matchCount != null ? plural(matchCount, noun[0], noun[1]) : `every ${noun[0]}`}
                        </h3>
                        <p className="text-[11.5px] text-ink-muted mt-0.5">
                            Every {noun[0]} in this view, each value exactly as stored.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(
                            'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                            'text-ink-muted hover:text-ink transition-colors',
                            'hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-5 py-4 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                    {phase.kind === 'choose' || phase.kind === 'failed' ? (
                        <>
                            {/* 1 · Format */}
                            <div role="radiogroup" aria-label="Format" className="grid grid-cols-2 gap-1.5">
                                {FORMATS.map((f) => (
                                    <button
                                        key={f.value}
                                        type="button"
                                        role="radio"
                                        aria-checked={format === f.value}
                                        onClick={() => setFormat(f.value)}
                                        className={cn(
                                            'text-left rounded-xl border px-3 py-2 transition-colors',
                                            format === f.value
                                                ? 'border-accent-lineage/60 bg-accent-lineage/10'
                                                : 'border-slate-200 dark:border-glass-border hover:border-accent-lineage/30',
                                        )}
                                    >
                                        <div className="text-[12px] font-semibold text-ink">{f.label}</div>
                                        <div className="text-[11px] text-ink-muted leading-snug">{f.description}</div>
                                    </button>
                                ))}
                            </div>

                            {/* 2 · Columns */}
                            <section aria-label="Columns" className="flex flex-col gap-2">
                                <div className="flex items-baseline justify-between gap-2">
                                    <h4 className="text-[12px] font-semibold text-ink">Columns</h4>
                                    <span className={cn('text-[11px] tabular-nums', full ? 'text-amber-500' : 'text-ink-muted')}>
                                        {full
                                            ? `${MAX_COLUMNS} properties — the most an export takes`
                                            : `${fixedColumns + columns.length} columns`}
                                    </span>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {baseColumns.map((c) => (
                                        <span key={c} className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] text-ink-secondary bg-black/[0.04] dark:bg-white/[0.05]">
                                            <Check className="w-3 h-3" /> {c}
                                        </span>
                                    ))}
                                    {!connections && (
                                        <>
                                            <ColumnToggle label="Description" on={withDescription} onChange={setWithDescription} />
                                            <ColumnToggle label="Tags" on={withTags} onChange={setWithTags} />
                                        </>
                                    )}
                                </div>
                                {connections && (
                                    <p className="text-[11px] text-ink-muted">
                                        Each end is its URN, name and type. Add an edge property to give it a column of its own.
                                    </p>
                                )}

                                <div className="relative">
                                    <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
                                    <input
                                        value={filter}
                                        onChange={(e) => setFilter(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && canAddTyped && !full) {
                                                e.preventDefault()
                                                setChosen((c) => [...c, typed])
                                                setFilter('')
                                            }
                                        }}
                                        placeholder={connections ? 'Find an edge property, or type one'
                                            : unavailable ? 'Type a property name' : 'Find a property, or type one'}
                                        aria-label="Find a property"
                                        className={cn(
                                            'w-full h-8 pl-8 pr-2 rounded-lg text-[12px] text-ink',
                                            'bg-black/[0.03] dark:bg-white/[0.04]',
                                            'border border-slate-200 dark:border-glass-border',
                                            'focus:outline-none focus:border-accent-lineage/60',
                                        )}
                                    />
                                </div>

                                {!connections && reading != null && (
                                    <p className="text-[11px] text-ink-muted">
                                        Reading the view's properties — {reading}%. The ones found so far are listed.
                                    </p>
                                )}

                                <div className="flex flex-col rounded-xl border border-slate-200 dark:border-glass-border divide-y divide-slate-200/70 dark:divide-white/[0.06] max-h-[34vh] overflow-y-auto custom-scrollbar">
                                    {byName.map((key) => (
                                        <PropertyRow key={key} name={key} note="added by name" on
                                                     onToggle={() => toggle(key)} />
                                    ))}
                                    {canAddTyped && (
                                        <button
                                            type="button"
                                            disabled={full}
                                            onClick={() => { setChosen((c) => [...c, typed]); setFilter('') }}
                                            className="flex items-center gap-2 px-3 py-2 text-left text-[12px] text-accent-lineage hover:bg-accent-lineage/10 disabled:opacity-50"
                                        >
                                            <Plus className="w-3.5 h-3.5" /> Add “{typed}” as a column
                                        </button>
                                    )}
                                    {properties.slice(0, SHOWN).map((p) => (
                                        <PropertyRow
                                            key={p.key}
                                            name={p.key}
                                            note={p.note}
                                            on={chosen.includes(p.key)}
                                            disabled={full && !chosen.includes(p.key)}
                                            onToggle={() => toggle(p.key)}
                                        />
                                    ))}
                                    {properties.length > SHOWN && (
                                        <p className="px-3 py-2 text-[11px] text-ink-muted">
                                            {(properties.length - SHOWN).toLocaleString()} more — type to narrow.
                                        </p>
                                    )}
                                    {properties.length === 0 && !canAddTyped && chosen.length === 0 && (
                                        <p className="px-3 py-2 text-[11px] text-ink-muted">
                                            {connections
                                                ? (choices.length ? 'No edge properties match.'
                                                    : 'No edge properties found on these edges — type a name to add one.')
                                                : unavailable
                                                    ? "This view's properties can't be listed here — type a name to add it."
                                                    : reading != null ? 'Looking for properties…' : 'No properties match.'}
                                        </p>
                                    )}
                                </div>
                            </section>
                            {phase.kind === 'failed' && (
                                <p role="alert" className="text-[11.5px] text-rose-400">{phase.message}</p>
                            )}
                        </>
                    ) : phase.kind === 'exporting' ? (
                        <Exporting answer={phase.answer} matchCount={matchCount} noun={noun[1]} />
                    ) : (
                        <Ready answer={phase.answer} />
                    )}
                </div>

                {/* Footer */}
                <div className={cn(
                    'flex items-center justify-end gap-2 px-5 py-3.5 shrink-0',
                    'border-t border-slate-200 dark:border-glass-border',
                    'bg-black/[0.02] dark:bg-white/[0.02]',
                )}>
                    {phase.kind === 'exporting' ? (
                        <FooterButton onClick={stop}>Stop</FooterButton>
                    ) : phase.kind === 'ready' ? (
                        <>
                            <FooterButton onClick={onClose}>Done</FooterButton>
                            <FooterButton
                                primary
                                onClick={() => triggerBrowserDownload(
                                    phase.url, phase.answer.filename ?? `search-export.${phase.answer.format}`)}
                            >
                                <Download className="w-3.5 h-3.5" /> Download again
                            </FooterButton>
                        </>
                    ) : (
                        <>
                            <FooterButton onClick={onClose}>Cancel</FooterButton>
                            <FooterButton primary onClick={start}>
                                <FileDown className="w-3.5 h-3.5" />
                                {phase.kind === 'failed' ? 'Try again' : 'Export'}
                            </FooterButton>
                        </>
                    )}
                </div>
            </motion.div>
        </div>
        </>,
        document.body,
    )
}


function Exporting({ answer, matchCount, noun }: {
    answer: SearchExportResult | null
    matchCount: number | null
    noun: string
}) {
    const progress = answer?.progress
    const percent = progress && progress.total > 0
        ? Math.min(99, Math.floor((progress.scanned / progress.total) * 100))
        : 0
    return (
        <div className="flex flex-col gap-2.5 py-2" aria-live="polite">
            <div className="text-[13px] font-semibold text-ink tabular-nums">
                Writing {noun} — {(answer?.rows ?? 0).toLocaleString()}
                {matchCount != null ? ` of ${matchCount.toLocaleString()}` : ''} so far
            </div>
            <ProgressBar value={percent} label={`Exporting the ${noun}`} />
            <p className="text-[11px] text-ink-muted">
                {answer ? `Read ${percent}% of the view. ` : 'Starting… '}
                Stopping keeps what's written for a while: export again to carry on.
            </p>
        </div>
    )
}


function Ready({ answer }: { answer: SearchExportResult }) {
    return (
        <div className="flex items-start gap-3 py-2" aria-live="polite">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/15">
                <Check className="w-4 h-4 text-emerald-500" />
            </div>
            <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink tabular-nums">
                    {plural(answer.rows, 'row')} exported
                </div>
                <div className="text-[11.5px] text-ink-muted truncate">
                    {answer.filename} · {plural(answer.columns.length, 'column')}
                </div>
                <p className="mt-1 text-[11px] text-ink-muted">
                    Your download has started. The link works for an hour.
                </p>
            </div>
        </div>
    )
}


function ColumnToggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onChange(!on)}
            className={cn(
                'inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] transition-colors',
                on
                    ? 'text-accent-lineage bg-accent-lineage/15'
                    : 'text-ink-muted border border-dashed border-slate-300 dark:border-glass-border hover:text-ink',
            )}
        >
            {on ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />} {label}
        </button>
    )
}


function PropertyRow({ name, note, on, disabled, onToggle }: {
    name: string
    note: string
    on: boolean
    disabled?: boolean
    onToggle: () => void
}) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={disabled}
            onClick={onToggle}
            className={cn(
                'flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                'hover:bg-black/[0.03] dark:hover:bg-white/[0.04] disabled:opacity-50',
            )}
        >
            <span className={cn(
                'w-4 h-4 rounded flex items-center justify-center shrink-0 border',
                on ? 'bg-accent-lineage border-accent-lineage text-white' : 'border-slate-300 dark:border-glass-border',
            )}>
                {on && <Check className="w-3 h-3" />}
            </span>
            <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-ink">{name}</span>
            <span className="shrink-0 text-[10.5px] text-ink-muted tabular-nums">{note}</span>
        </button>
    )
}


function FooterButton({ primary, onClick, children }: {
    primary?: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12px] transition-colors',
                primary
                    ? 'font-semibold bg-accent-lineage hover:bg-accent-lineage/90 text-white shadow-sm shadow-accent-lineage/30'
                    : 'font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
            )}
        >
            {children}
        </button>
    )
}


/** The edge types an edge property is set on, in a note short enough to
 *  leave its name room: two named, then how many more. */
function onEdgeTypes(types: string[]): string {
    const named = types.slice(0, 2).map(edgeTypeName).join(', ')
    return types.length > 2 ? `on ${named} and ${types.length - 2} more` : `on ${named}`
}

/** The edge properties discovery found on ``edgeTypes`` (all, when none are
 *  named), each with the edge types carrying it. */
function useEdgeKeys(viewId: string | null, edgeTypes: string[] | null): Array<{ key: string; types: string[] }> {
    const { keysByEdgeType } = useDiscovery(viewId)
    return useMemo(() => {
        const only = edgeTypes?.length ? new Set(edgeTypes.map((t) => t.toUpperCase())) : null
        const byKey = new Map<string, string[]>()
        for (const [type, keys] of Object.entries(keysByEdgeType)) {
            if (only && !only.has(type.toUpperCase())) continue
            for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), type])
        }
        return [...byKey].map(([key, types]) => ({ key, types }))
    }, [keysByEdgeType, edgeTypes])
}


/** What a failed export tells the person who asked for it. */
function failureMessage(e: unknown): string {
    const status = httpStatusOf(e)
    if (status === 403) return "You can't export matches from this view."
    if (status === 404) return 'This view is no longer available.'
    if (status === 501) return "This data source can't export search matches."
    const detail = serverDetail(e)
    if (status === 400 && detail) return detail
    return `Couldn't export — ${detail ?? (e as Error)?.message ?? 'unknown error'}`
}


function serverDetail(e: unknown): string | null {
    const message = (e as Error)?.message ?? ''
    const body = message.replace(/^API Error \d+: /, '')
    try {
        const parsed = JSON.parse(body) as { detail?: unknown }
        if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
        // Not JSON: no detail to show.
    }
    return null
}


function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`
}
