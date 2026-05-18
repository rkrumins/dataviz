/**
 * Dev-only smoke harness for the advanced search backend.
 *
 * Mounted in canvas components ONLY when the URL contains `?devSearch=1`
 * (or `&devSearch=1`). Renders a fixed bottom-right overlay with:
 *   - a textarea pre-populated with a sample `SearchQuery` JSON body,
 *   - a "Run" button that POSTs to /api/v1/{ws}/graph/search/advanced,
 *   - a pretty-printed JSON pane for the response (or the error),
 *   - status text with latency.
 *
 * This is NOT the production search UX. It's a smoke harness so we
 * can exercise the new endpoint from a browser end-to-end before any
 * of the real search UX lands (QuickSearchBar, AdvancedSearchPanel,
 * SearchMapPanel, SearchResultsDock).
 *
 * Lifecycle: component returns null when the URL flag isn't set, so
 * the overlay disappears entirely on normal navigations. No keyboard
 * shortcut on purpose — keep this strictly opt-in via URL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type {
    SearchQuery,
    SearchResultPage,
    SearchExplainResult,
    SearchDiscoverResult,
} from '@/types/search'

/**
 * Pre-canned query shapes — clickable from the panel's preset dropdown.
 *
 * These are chosen to exercise different shapes of the SearchQuery
 * contract (every predicate kind, both result shapes, aggregations,
 * composition). Values like `'PII'` / `'Raw'` / `'int_'` are best-effort
 * for typical seeded data; if a preset returns 0 results in your
 * environment, edit the textarea and re-run. The shapes themselves
 * are validated against `backend/common/models/search.py`.
 *
 * The dropdown loads a preset into the textarea on selection; the
 * user is then free to edit before pressing Run.
 */
const PRESETS: Record<string, SearchQuery> = {
    'Aggregate: tag=PII by domain': {
        predicate: { kind: 'tag', op: 'has', values: ['PII'] },
        options: {
            results: 'aggregates',
            aggregations: [
                {
                    by: 'ancestorType',
                    ancestorEntityTypes: ['domain'],
                    maxBuckets: 20,
                    sampleHitsPerBucket: 3,
                },
            ],
        },
    },
    'Aggregate by entity type (everything)': {
        // hasProperty:'urn' matches every node (urn is always set), so
        // this is a cheap way to get a per-type roll-up of the whole graph
        predicate: { kind: 'hasProperty', key: 'urn' },
        options: {
            results: 'aggregates',
            aggregations: [{ by: 'entityType', maxBuckets: 50 }],
        },
    },
    'Hits: name contains "int_"': {
        predicate: {
            kind: 'text', target: 'name', value: 'int_', match: 'substring',
        },
        options: { results: 'hits', pageSize: 20 },
    },
    'Hits: layerAssignment = Raw': {
        // NOTE: the value here must match the *raw* layerAssignment string
        // stored on the node — usually the layer ID, not the display label.
        // If this returns 0 results, run the "Has property: layerAssignment"
        // preset first to see what values exist.
        predicate: { kind: 'layer', layerAssignment: 'Raw' },
        options: { results: 'hits', pageSize: 20 },
    },
    'Hits: entityType in [dataset]': {
        predicate: { kind: 'entityType', op: 'in', values: ['dataset'] },
        options: {
            results: 'hits', pageSize: 20, includeAncestorPath: true,
        },
    },
    'Composite AND: dataset whose name contains "clean"': {
        predicate: {
            kind: 'group', op: 'and', children: [
                { kind: 'entityType', op: 'in', values: ['dataset'] },
                {
                    kind: 'text', target: 'name',
                    value: 'clean', match: 'substring',
                },
            ],
        },
        options: { results: 'both', pageSize: 10 },
    },
    'Composite OR: tag=PII OR has property pii_class': {
        predicate: {
            kind: 'group', op: 'or', children: [
                { kind: 'tag', op: 'has', values: ['PII'] },
                { kind: 'hasProperty', key: 'pii_class' },
            ],
        },
        options: {
            results: 'aggregates',
            aggregations: [{ by: 'entityType' }],
        },
    },
    'Discovery: aggregate nodes-with-layerAssignment by entityType': {
        // Useful when you don't know what layer values exist in your data:
        // returns one bucket per entityType for nodes that have a layer set.
        // Inspect the response to see what to pass to the 'Layer:' preset.
        predicate: { kind: 'hasProperty', key: 'layerAssignment' },
        options: {
            results: 'aggregates',
            aggregations: [{ by: 'entityType', sampleHitsPerBucket: 5 }],
        },
    },
    'Property: rowCount > 1000 (if your data has rowCount)': {
        predicate: { kind: 'property', key: 'rowCount', op: 'gt', value: 1000 },
        options: { results: 'hits', pageSize: 10 },
    },
}

const DEFAULT_PRESET_NAME = 'Aggregate: tag=PII by domain'
const EXAMPLE_QUERY: SearchQuery = PRESETS[DEFAULT_PRESET_NAME]

function isDevSearchEnabled(): boolean {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('devSearch') === '1'
}

type RunState =
    | { status: 'idle' }
    | { status: 'running'; startedAt: number; action: 'run' | 'explain' | 'discover' }
    | { status: 'ok'; result: SearchResultPage; elapsedMs: number }
    | { status: 'explainOk'; result: SearchExplainResult; elapsedMs: number }
    | { status: 'discoverOk'; result: SearchDiscoverResult; elapsedMs: number }
    | { status: 'error'; message: string; elapsedMs: number; action: 'run' | 'explain' | 'discover' }

export function AdvancedSearchDevPanel() {
    // Re-evaluate on mount + on popstate (back/forward); browsers don't
    // emit a synthetic event when the user edits the URL bar, so we
    // also watch hash/path on a short interval. Cheap enough — this
    // component only renders in dev.
    const [enabled, setEnabled] = useState<boolean>(isDevSearchEnabled)
    useEffect(() => {
        const recheck = () => setEnabled(isDevSearchEnabled())
        window.addEventListener('popstate', recheck)
        const id = window.setInterval(recheck, 1000)
        return () => {
            window.removeEventListener('popstate', recheck)
            window.clearInterval(id)
        }
    }, [])

    if (!enabled) return null
    return <DevPanelInner />
}

function DevPanelInner() {
    const provider = useGraphProvider()
    const [bodyText, setBodyText] = useState<string>(
        JSON.stringify(EXAMPLE_QUERY, null, 2),
    )
    const [runState, setRunState] = useState<RunState>({ status: 'idle' })
    const [collapsed, setCollapsed] = useState(false)
    const abortRef = useRef<AbortController | null>(null)

    const canRunHere = useMemo(
        () => provider instanceof RemoteGraphProvider,
        [provider],
    )

    /** Parse the textarea as a SearchQuery; centralises the error
     * shape so the three action buttons (run / explain) share it. */
    const parseBody = useCallback((): SearchQuery | { error: string } => {
        try {
            return JSON.parse(bodyText) as SearchQuery
        } catch (e) {
            return { error: `JSON parse error: ${(e as Error).message}` }
        }
    }, [bodyText])

    const beginAction = useCallback(
        (action: 'run' | 'explain' | 'discover'): AbortController | null => {
            if (!canRunHere) {
                setRunState({
                    status: 'error',
                    action,
                    message:
                        'Active provider is not RemoteGraphProvider; the dev ' +
                        'panel only works against the live backend.',
                    elapsedMs: 0,
                })
                return null
            }
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            setRunState({ status: 'running', startedAt: performance.now(), action })
            return controller
        },
        [canRunHere],
    )

    const run = useCallback(async () => {
        const parsed = parseBody()
        if ('error' in parsed) {
            setRunState({
                status: 'error', action: 'run',
                message: parsed.error, elapsedMs: 0,
            })
            return
        }
        const controller = beginAction('run')
        if (!controller) return
        const startedAt = performance.now()
        try {
            const result = await (provider as RemoteGraphProvider).searchAdvanced(parsed)
            if (controller.signal.aborted) return
            setRunState({
                status: 'ok', result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            setRunState({
                status: 'error', action: 'run',
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        }
    }, [parseBody, beginAction, provider])

    /** Calls /search/explain — compile-only, no FalkorDB round-trip.
     * Surfaces the generated Cypher so the user can see exactly what's
     * being asked. First stop for diagnosing 0-result queries. */
    const explain = useCallback(async () => {
        const parsed = parseBody()
        if ('error' in parsed) {
            setRunState({
                status: 'error', action: 'explain',
                message: parsed.error, elapsedMs: 0,
            })
            return
        }
        const controller = beginAction('explain')
        if (!controller) return
        const startedAt = performance.now()
        try {
            const result = await (provider as RemoteGraphProvider).searchExplain(parsed)
            if (controller.signal.aborted) return
            setRunState({
                status: 'explainOk', result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            setRunState({
                status: 'error', action: 'explain',
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        }
    }, [parseBody, beginAction, provider])

    /** Calls /search/discover — samples each entity-type label and
     * reports which native property keys are present. Answers
     * "what can I actually query?". */
    const discover = useCallback(async () => {
        const controller = beginAction('discover')
        if (!controller) return
        const startedAt = performance.now()
        try {
            const result = await (provider as RemoteGraphProvider)
                .discoverSearchableProperties(200)
            if (controller.signal.aborted) return
            setRunState({
                status: 'discoverOk', result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            setRunState({
                status: 'error', action: 'discover',
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        }
    }, [beginAction, provider])

    // Stop the inflight request if the panel unmounts.
    useEffect(() => () => abortRef.current?.abort(), [])

    return (
        <div
            style={{
                position: 'fixed',
                bottom: 12,
                right: 12,
                width: collapsed ? 220 : 520,
                maxHeight: collapsed ? 36 : 'calc(100vh - 80px)',
                background: 'rgba(20, 22, 28, 0.96)',
                color: '#e6e8eb',
                border: '1px solid #3a3f4a',
                borderRadius: 6,
                boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
                zIndex: 9999,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 12,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
            }}
            data-testid="advanced-search-dev-panel"
        >
            <div
                style={{
                    padding: '6px 10px',
                    borderBottom: collapsed ? 'none' : '1px solid #3a3f4a',
                    background: '#252830',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                }}
                onClick={() => setCollapsed((c) => !c)}
                title="Click to collapse / expand"
            >
                <span style={{ color: '#9bd' }}>{'⚙'}</span>
                <span style={{ fontWeight: 600 }}>Advanced Search · dev</span>
                <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
                    {collapsed ? '▴' : '▾'}
                </span>
            </div>

            {!collapsed && (
                <>
                    <div style={{ padding: 8 }}>
                        <div style={{ marginBottom: 4, opacity: 0.7 }}>
                            SearchQuery JSON body:
                        </div>
                        <textarea
                            value={bodyText}
                            onChange={(e) => setBodyText(e.target.value)}
                            spellCheck={false}
                            rows={14}
                            style={{
                                width: '100%',
                                background: '#11141a',
                                color: '#e6e8eb',
                                border: '1px solid #3a3f4a',
                                borderRadius: 4,
                                padding: 6,
                                fontFamily: 'inherit',
                                fontSize: 11.5,
                                resize: 'vertical',
                                boxSizing: 'border-box',
                            }}
                            onKeyDown={(e) => {
                                // ⌘/Ctrl + Enter to submit
                                if (
                                    (e.metaKey || e.ctrlKey) &&
                                    e.key === 'Enter'
                                ) {
                                    e.preventDefault()
                                    void run()
                                }
                            }}
                        />
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginTop: 6,
                            }}
                        >
                            <button
                                onClick={() => void run()}
                                disabled={runState.status === 'running'}
                                style={{
                                    background: '#3b82f6',
                                    color: '#fff',
                                    border: 'none',
                                    padding: '5px 12px',
                                    borderRadius: 4,
                                    cursor:
                                        runState.status === 'running'
                                            ? 'not-allowed'
                                            : 'pointer',
                                    fontWeight: 600,
                                    fontFamily: 'inherit',
                                }}
                            >
                                {runState.status === 'running' &&
                                runState.action === 'run'
                                    ? 'Running…'
                                    : 'Run (⌘↵)'}
                            </button>
                            <button
                                onClick={() => void explain()}
                                disabled={runState.status === 'running'}
                                title="Compile this SearchQuery to Cypher without running it (POST /search/explain)"
                                style={{
                                    background: 'transparent',
                                    color: '#9bd',
                                    border: '1px solid #3a3f4a',
                                    padding: '4px 10px',
                                    borderRadius: 4,
                                    cursor:
                                        runState.status === 'running'
                                            ? 'not-allowed'
                                            : 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                {runState.status === 'running' &&
                                runState.action === 'explain'
                                    ? 'Explaining…'
                                    : 'Show Cypher'}
                            </button>
                            <button
                                onClick={() => void discover()}
                                disabled={runState.status === 'running'}
                                title="Sample the graph and report what native properties exist per entity-type label (GET /search/discover)"
                                style={{
                                    background: 'transparent',
                                    color: '#9bd',
                                    border: '1px solid #3a3f4a',
                                    padding: '4px 10px',
                                    borderRadius: 4,
                                    cursor:
                                        runState.status === 'running'
                                            ? 'not-allowed'
                                            : 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                {runState.status === 'running' &&
                                runState.action === 'discover'
                                    ? 'Discovering…'
                                    : 'Discover properties'}
                            </button>
                            <select
                                onChange={(e) => {
                                    const preset = PRESETS[e.target.value]
                                    if (preset) {
                                        setBodyText(
                                            JSON.stringify(preset, null, 2),
                                        )
                                    }
                                    // Reset the select back to the prompt so
                                    // the same preset can be reloaded after edits
                                    e.target.value = ''
                                }}
                                defaultValue=""
                                style={{
                                    background: '#11141a',
                                    color: '#9bd',
                                    border: '1px solid #3a3f4a',
                                    padding: '4px 8px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                    maxWidth: 240,
                                }}
                                title="Load a canned query into the textarea"
                            >
                                <option value="">Load preset…</option>
                                {Object.keys(PRESETS).map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                                {renderStatus(runState)}
                            </span>
                        </div>
                    </div>

                    <div
                        style={{
                            padding: 8,
                            borderTop: '1px solid #3a3f4a',
                            overflowY: 'auto',
                            flex: 1,
                            minHeight: 120,
                        }}
                    >
                        <div style={{ marginBottom: 4, opacity: 0.7 }}>
                            {renderResponseLabel(runState)}
                        </div>
                        <pre
                            style={{
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                fontSize: 11.5,
                                color:
                                    runState.status === 'error'
                                        ? '#fca5a5'
                                        : '#e6e8eb',
                            }}
                        >
                            {renderResponseBody(runState)}
                        </pre>
                        {renderEmptyStateHint(runState)}
                    </div>
                </>
            )}
        </div>
    )
}

function renderStatus(state: RunState): string {
    if (state.status === 'idle') return 'idle'
    if (state.status === 'running') {
        const elapsed = Math.round(performance.now() - state.startedAt)
        return `${state.action}… ${elapsed}ms`
    }
    if (state.status === 'ok') {
        const r = state.result
        const aggCount = (r.aggregates ?? []).reduce((sum, b) => sum + b.length, 0)
        const hitCount = r.hits?.length ?? 0
        return [
            `${state.elapsedMs}ms`,
            `candidates=${r.candidateCount}`,
            `aggBuckets=${aggCount}`,
            `hits=${hitCount}`,
            r.truncated ? 'truncated' : '',
            r.deadlineExceeded ? 'deadlineExceeded' : '',
            r.cacheHit ? 'cache=HIT' : '',
        ]
            .filter(Boolean)
            .join(' · ')
    }
    if (state.status === 'explainOk') {
        const paramCount = Object.keys(state.result.params).length
        const noteCount = state.result.notes.length
        return [
            `explain · ${state.elapsedMs}ms`,
            `params=${paramCount}`,
            noteCount > 0 ? `notes=${noteCount}` : '',
        ]
            .filter(Boolean)
            .join(' · ')
    }
    if (state.status === 'discoverOk') {
        const labelCount = Object.keys(state.result.labels).length
        const totalKeys = Object.values(state.result.labels).reduce(
            (n, l) => n + l.keys.length, 0,
        )
        const blobOnly = state.result.blobOnlyLabels.length
        return [
            `discover · ${state.elapsedMs}ms`,
            `labels=${labelCount}`,
            `totalKeys=${totalKeys}`,
            blobOnly > 0 ? `blobOnlyLabels=${blobOnly}` : '',
        ]
            .filter(Boolean)
            .join(' · ')
    }
    return `error · ${state.elapsedMs}ms`
}

function renderResponseLabel(state: RunState): string {
    if (state.status === 'explainOk') return 'Compiled Cypher (compile-only, not executed):'
    if (state.status === 'discoverOk') return 'Discovered native properties per label:'
    if (state.status === 'error') return `Error from /search/${state.action}:`
    return 'Response:'
}

function renderResponseBody(state: RunState): string {
    if (state.status === 'idle') return '(run the query to see the response)'
    if (state.status === 'running') return '…'
    if (state.status === 'error') return state.message
    if (state.status === 'explainOk') return renderExplainBody(state.result)
    if (state.status === 'discoverOk') return renderDiscoverBody(state.result)
    return JSON.stringify(state.result, null, 2)
}

function renderExplainBody(r: SearchExplainResult): string {
    // Foreground the Cypher; full JSON underneath for completeness.
    const lines: string[] = []
    lines.push('# Hits cypher (what `Run` would execute)')
    lines.push(r.hits_cypher)
    lines.push('')
    lines.push('# Bound params')
    lines.push(JSON.stringify(r.params, null, 2))
    if (r.notes.length > 0) {
        lines.push('')
        lines.push('# Diagnostic notes')
        for (const n of r.notes) lines.push(`  - ${n}`)
    }
    lines.push('')
    lines.push('# Full explain payload')
    lines.push(JSON.stringify(r, null, 2))
    return lines.join('\n')
}

function renderDiscoverBody(r: SearchDiscoverResult): string {
    const lines: string[] = []
    if (r.missingContainment) {
        lines.push(
            '!! No containment edge types configured on this provider — ',
        )
        lines.push(
            '   scope.root_urns will be silently ignored. Aggregations by ',
        )
        lines.push('   ancestorType will return empty buckets.')
        lines.push('')
    }
    if (r.blobOnlyLabels.length > 0) {
        lines.push('!! Labels with nodes but no native properties — ')
        lines.push('   these are likely pre-W1 blob-stored. Run:')
        lines.push('     python -m backend.scripts.migrate_native_properties')
        lines.push('   to make property predicates work against them.')
        for (const l of r.blobOnlyLabels) lines.push(`     - ${l}`)
        lines.push('')
    }
    lines.push('# Native property keys per label')
    for (const [label, info] of Object.entries(r.labels)) {
        if (info.keys.length === 0) {
            lines.push(
                `  ${label}  (sampled ${info.sampled}, 0 native keys — blob-only?)`,
            )
        } else {
            lines.push(`  ${label}  (sampled ${info.sampled}):`)
            for (const k of info.keys) lines.push(`    • ${k}`)
        }
    }
    return lines.join('\n')
}

/** Renders a diagnostic hint card below the response when a search
 * returned 0 results. Tells the user the most-likely causes and
 * points them at the explain / discover buttons. */
function renderEmptyStateHint(state: RunState) {
    if (state.status !== 'ok') return null
    const r = state.result
    const aggCount = (r.aggregates ?? []).reduce((sum, b) => sum + b.length, 0)
    const hitCount = r.hits?.length ?? 0
    const isEmpty = r.candidateCount === 0 && aggCount === 0 && hitCount === 0
    if (!isEmpty) return null
    return (
        <div
            style={{
                marginTop: 10,
                padding: 8,
                background: 'rgba(250, 204, 21, 0.08)',
                border: '1px solid rgba(250, 204, 21, 0.4)',
                borderRadius: 4,
                color: '#fde68a',
                fontSize: 11.5,
                lineHeight: 1.5,
            }}
            data-testid="advanced-search-empty-hint"
        >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
                0 candidates matched — common causes:
            </div>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                    <b>Pre-W1 blob storage</b>: property predicates only work
                    against natively-stored properties. Click{' '}
                    <i>Discover properties</i> — if your labels show up in{' '}
                    <code>blobOnlyLabels</code>, run{' '}
                    <code>python -m backend.scripts.migrate_native_properties</code>
                    {' '}or re-seed from the worktree.
                </li>
                <li>
                    <b>Value type mismatch</b>: you sent <code>"1000"</code>{' '}
                    but the stored value is the integer <code>1000</code>. Use
                    a numeric literal (no quotes) in the JSON for numeric
                    properties.
                </li>
                <li>
                    <b>Property name typo / case sensitivity</b> (
                    <code>n.Schema</code> ≠ <code>n.schema</code>). Click{' '}
                    <i>Show Cypher</i> to see the exact field being queried,
                    then <i>Discover properties</i> to see what's actually
                    present.
                </li>
                <li>
                    <b>No node has this value</b>. Try{' '}
                    <i>Discover properties</i> to see which property values
                    exist in your data.
                </li>
            </ol>
        </div>
    )
}
