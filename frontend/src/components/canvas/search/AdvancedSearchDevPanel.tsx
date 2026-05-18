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
import type { SearchQuery, SearchResultPage } from '@/types/search'

const EXAMPLE_QUERY: SearchQuery = {
    predicate: {
        kind: 'tag',
        op: 'has',
        values: ['PII'],
    },
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
}

function isDevSearchEnabled(): boolean {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('devSearch') === '1'
}

type RunState =
    | { status: 'idle' }
    | { status: 'running'; startedAt: number }
    | { status: 'ok'; result: SearchResultPage; elapsedMs: number }
    | { status: 'error'; message: string; elapsedMs: number }

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

    const run = useCallback(async () => {
        // Validate JSON synchronously so the user sees a parse error
        // before we burn a round-trip.
        let parsed: SearchQuery
        try {
            parsed = JSON.parse(bodyText) as SearchQuery
        } catch (e) {
            setRunState({
                status: 'error',
                message: `JSON parse error: ${(e as Error).message}`,
                elapsedMs: 0,
            })
            return
        }
        if (!canRunHere) {
            setRunState({
                status: 'error',
                message:
                    'Active provider is not RemoteGraphProvider; the dev ' +
                    'panel only works against the live backend.',
                elapsedMs: 0,
            })
            return
        }

        // Cancel any in-flight prior request.
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const startedAt = performance.now()
        setRunState({ status: 'running', startedAt })

        try {
            const result = await (provider as RemoteGraphProvider).searchAdvanced(parsed)
            if (controller.signal.aborted) return
            setRunState({
                status: 'ok',
                result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            setRunState({
                status: 'error',
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        }
    }, [bodyText, provider, canRunHere])

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
                                {runState.status === 'running' ? 'Running…' : 'Run (⌘↵)'}
                            </button>
                            <button
                                onClick={() =>
                                    setBodyText(JSON.stringify(EXAMPLE_QUERY, null, 2))
                                }
                                style={{
                                    background: 'transparent',
                                    color: '#9bd',
                                    border: '1px solid #3a3f4a',
                                    padding: '4px 10px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                Reset to example
                            </button>
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
                        <div style={{ marginBottom: 4, opacity: 0.7 }}>Response:</div>
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
        return `running… ${elapsed}ms`
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
    return `error · ${state.elapsedMs}ms`
}

function renderResponseBody(state: RunState): string {
    if (state.status === 'idle') return '(run the query to see the response)'
    if (state.status === 'running') return '…'
    if (state.status === 'error') return state.message
    return JSON.stringify(state.result, null, 2)
}
