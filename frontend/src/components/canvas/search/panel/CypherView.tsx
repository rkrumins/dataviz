/**
 * CypherView — the Query card's Cypher tab: the query in words, and the
 * Cypher it compiles to — exactly what a run sends (``useCompiledQuery``
 * builds the run's own request), coloured, with its bound parameters and
 * the compiler's notes.
 *
 *   ┌─ Compiled Cypher · 482 chars ────────────  [ Copy ] ─┐
 *   │ MATCH (n) WHERE …                                     │
 *   └───────────────────────────────────────────────────────┘
 *
 * **Copy** gives the statement with its values written in, so it runs as
 * it is anywhere Cypher runs. A data source that compiles no Cypher (only
 * FalkorDB does) says so, instead of a spinner that never stops.
 *
 * Below it, for whoever may query the view's data source: Edit and run,
 * starting from that same statement (``NativeConsole``).
 */
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Info, Loader2 } from 'lucide-react'
import { type FC, type ReactNode, useCallback, useState } from 'react'

import { cn } from '@/lib/utils'
import { useIsDraftMode } from '@/store/branchStore'
import { useDraftPredicate } from '@/store/searchStore'

import { CypherEditor } from '../editor/CypherEditor'

import { NativeConsole } from './native/NativeConsole'
import { useCompiledQuery } from './native/useCompiledQuery'
import { useNativeQueryEngine } from './native/useNativeQueryEngine'
import { QuerySentence } from './QuerySentence'


export interface CypherViewProps {
    viewId: string
}


export const CypherView: FC<CypherViewProps> = ({ viewId }) => {
    const draft = useDraftPredicate()
    const compiled = useCompiledQuery(draft, viewId)
    const nativeEngine = useNativeQueryEngine()
    const onDraft = useIsDraftMode()

    let body: ReactNode
    if (compiled.status === 'empty') {
        body = <Notice>Add a condition to see the Cypher it runs as.</Notice>
    } else if (compiled.status === 'unsupported') {
        body = (
            <Notice>
                This data source doesn't show a compiled query — searches on it aren't run
                as Cypher here.
            </Notice>
        )
    } else if (compiled.status === 'compiling') {
        body = (
            <div className={cn(
                'flex items-center gap-2 px-3 py-3 rounded-xl',
                'border border-glass-border/50 bg-canvas-base/30',
                'text-[12px] text-ink-muted',
            )}>
                <Loader2 className="w-4 h-4 animate-spin text-accent-lineage" />
                Compiling the query…
            </div>
        )
    } else if (compiled.status === 'error') {
        body = (
            <div className={cn(
                'flex items-start gap-2 px-3 py-3 rounded-xl',
                'border border-rose-500/40 bg-rose-500/10',
                'text-[12px] text-rose-700 dark:text-rose-300',
            )}>
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="flex flex-col gap-0.5">
                    <span className="font-semibold">It didn't compile</span>
                    <span className="opacity-90">{compiled.message}</span>
                </div>
            </div>
        )
    } else {
        const { result } = compiled
        const cypher = result.hits_cypher || result.cypher
        const params = result.params ?? {}
        const notes = result.notes ?? []
        body = (
            <>
                <SuccessRibbon noteCount={notes.length} />
                <Block
                    title="Compiled Cypher"
                    subtitle={`${cypher.length.toLocaleString()} chars`}
                    copy={result.inlinedCypher ?? cypher}
                    copyLabel={result.inlinedCypher ? 'Copy with values' : 'Copy'}
                >
                    <CypherEditor
                        value={prettyPrintCypher(cypher)}
                        readOnly
                        ariaLabel="Compiled Cypher"
                        className="max-h-72 overflow-y-auto custom-scrollbar -mx-3 -my-2.5"
                    />
                </Block>
                {typeof result.candidate_cap === 'number' && <CandidateCapHint cap={result.candidate_cap} />}
                {Object.keys(params).length > 0 && <ParamsBlock params={params} />}
                {notes.length > 0 && <NotesBlock notes={notes} />}
            </>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <QuerySentence draftPredicate={draft} />
            {body}
            {nativeEngine && (
                <NativeConsole
                    viewId={viewId}
                    engine={nativeEngine}
                    seed={compiled.status === 'ok' ? compiled.result.inlinedCypher ?? null : null}
                    unavailable={onDraft
                        ? 'Native queries read the published graph. Switch the view to main to run one.'
                        : null}
                />
            )}
        </div>
    )
}


function CandidateCapHint({ cap }: { cap: number }) {
    return (
        <div className={cn(
            'flex items-start gap-2 px-3 py-2 rounded-lg',
            'border border-glass-border/50 bg-canvas-base/30',
            'text-[10.5px] text-ink-muted leading-snug',
        )}>
            <Info className="w-3 h-3 mt-0.5 shrink-0 text-accent-lineage/70" />
            <span>
                The trailing{' '}
                <span className="font-mono text-ink">WITH n LIMIT {cap.toLocaleString()}</span>
                {' '}is the <span className="text-ink">candidate cap</span> — the most entities
                one statement looks at. A large view is searched in parts, each its own
                statement, so every match is still found.
            </span>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SuccessRibbon({ noteCount }: { noteCount: number }) {
    return (
        <div className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg',
            'border border-emerald-500/30 bg-emerald-500/[0.06]',
            'text-[11.5px] text-emerald-700 dark:text-emerald-300 font-medium',
        )}>
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            Compiled — this is the query a run sends.
            {noteCount > 0 && (
                <span className="ml-auto text-[10.5px] text-amber-700 dark:text-amber-300/90 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {noteCount} note{noteCount === 1 ? '' : 's'} below
                </span>
            )}
        </div>
    )
}


function ParamsBlock({ params }: { params: Record<string, unknown> }) {
    return (
        <Block
            title="Bound parameters"
            subtitle={`${Object.keys(params).length}`}
            copy={JSON.stringify(params, null, 2)}
        >
            <div className="flex flex-col gap-1">
                {Object.entries(params).map(([k, v]) => (
                    <div
                        key={k}
                        className={cn(
                            'flex items-start gap-3 py-1 text-[11.5px] font-mono leading-tight',
                            'border-b border-glass-border/20 last:border-b-0',
                        )}
                    >
                        <span className="text-accent-lineage shrink-0">${k}</span>
                        <span className="flex-1 min-w-0 text-ink/90 break-all">{formatValue(v)}</span>
                    </div>
                ))}
            </div>
        </Block>
    )
}


function NotesBlock({ notes }: { notes: string[] }) {
    return (
        <Block title="Diagnostic notes" subtitle={`${notes.length}`} copy={notes.join('\n\n')} tone="amber">
            <ul className="flex flex-col gap-2">
                {notes.map((n, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug text-amber-800 dark:text-amber-200/95">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
                        <span>{n}</span>
                    </li>
                ))}
            </ul>
        </Block>
    )
}


// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function Block({
    title, subtitle, copy, copyLabel = 'Copy', tone = 'default', children,
}: {
    title: string
    subtitle?: string
    copy: string
    copyLabel?: string
    tone?: 'default' | 'amber'
    children: ReactNode
}) {
    const [copied, setCopied] = useState(false)
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(copy)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
        } catch {
            // Clipboard API may be unavailable; silently no-op.
        }
    }, [copy])

    return (
        <div className={cn(
            'rounded-xl border overflow-hidden',
            tone === 'amber'
                ? 'border-amber-500/30 bg-amber-500/[0.04]'
                : 'border-glass-border/60 bg-canvas-base/40',
        )}>
            <div className={cn('flex items-center justify-between gap-2 px-3 py-2', 'border-b border-glass-border/40')}>
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                        {title}
                    </span>
                    {subtitle && (
                        <span className="text-[10.5px] text-ink-muted/70 tabular-nums">· {subtitle}</span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleCopy}
                    title={copied ? 'Copied' : `${copyLabel}: ${title.toLowerCase()}`}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md shrink-0',
                        'text-[10.5px] font-medium transition-colors',
                        copied
                            ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                            : 'bg-glass/40 text-ink-muted hover:text-ink hover:bg-glass/60',
                    )}
                >
                    <Copy className="w-3 h-3" />
                    {copied ? 'Copied' : copyLabel}
                </button>
            </div>
            <div className="px-3 py-2.5">{children}</div>
        </div>
    )
}


function Notice({ children }: { children: ReactNode }) {
    return (
        <div className={cn(
            'flex items-start gap-2 px-3 py-4 rounded-xl',
            'border border-dashed border-glass-border/60 bg-canvas-base/20',
            'text-[12px] text-ink-muted leading-relaxed',
        )}>
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-accent-lineage/70" />
            <span>{children}</span>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Light-touch Cypher prettifier: keep the original string but insert
 * newlines before the major keywords so the statement reads at a glance.
 * Doesn't reformat semantics.
 */
function prettyPrintCypher(cypher: string): string {
    return cypher
        .replace(/\s+(WHERE|WITH|RETURN|MATCH|ORDER BY|LIMIT|UNWIND|OPTIONAL MATCH|UNION)\b/g, '\n$1')
        .replace(/\s+(AND|OR)\s+/g, '\n  $1 ')
        .trim()
}


function formatValue(v: unknown): string {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) {
        const s = JSON.stringify(v)
        return s.length > 60 ? s.slice(0, 60) + '… (' + v.length + ')' : s
    }
    return JSON.stringify(v)
}
