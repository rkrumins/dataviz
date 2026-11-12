/**
 * The graph and hierarchy layouts' search at a past revision: names only.
 *
 * A revision answers one search exactly as the graph was, a name search, so their Advanced Search
 * gives way to this box. Each hit carries the path down to it and is revealed on the canvas as any
 * search hit is; the box says why nothing but names is searched. The provider sends the query to
 * `/search/names` (`providers/revisionReads.ts`), at most 50 hits a page, and Load more asks for
 * the next page by the cursor the last one came with.
 */
import { Loader2, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { AT_REVISION_READS } from '@/features/versioning/model/revisionCopy'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { AncestorRef, SearchHit, SearchQuery } from '@/types/search'

import { SearchHitRow } from './SearchHitRow'
import { currentScope } from './searchRequest'

const PAGE_SIZE = 50

/** One text leaf on names, in the scope the layout's own search runs in. */
function nameQuery(viewId: string, value: string, cursor?: string): SearchQuery {
    return {
        predicate: { kind: 'text', target: 'name', value, match: 'substring' },
        scope: currentScope(viewId),
        options: cursor ? { pageSize: PAGE_SIZE, cursor } : { pageSize: PAGE_SIZE },
    }
}

/** What the server said about one name: the hits so far, and the next page's cursor if any. */
interface Answer {
    q: string
    hits: SearchHit[]
    cursor: string | null
    failed: boolean
}

export interface RevisionNameSearchPanelProps {
    viewId: string
    onClose: () => void
    /** Open the canvas down to a hit: the layout's `useRevealSearchHit`. */
    onRevealNode: (urn: string, ancestorPath: AncestorRef[]) => void | Promise<unknown>
}

export function RevisionNameSearchPanel({ viewId, onClose, onRevealNode }: RevisionNameSearchPanelProps) {
    // A revision is read from the backend: only its provider searches.
    const provider = useGraphProvider()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const [text, setText] = useState('')
    const q = useDebouncedValue(text.trim(), 250)
    const [answer, setAnswer] = useState<Answer | null>(null)
    // The cursor of the page being fetched, so its button waits for it.
    const [fetching, setFetching] = useState<string | null>(null)
    // Bumped by Try again, after a first page that failed.
    const [attempt, setAttempt] = useState(0)

    // A new name asks again, and an answer to a name typed past is dropped.
    useEffect(() => {
        if (!q || !remote) return
        const controller = new AbortController()
        remote.searchAdvanced(nameQuery(viewId, q), { signal: controller.signal }).then(
            (page) => {
                if (controller.signal.aborted) return
                setAnswer({ q, hits: page.hits ?? [], cursor: page.cursor ?? null, failed: false })
            },
            () => {
                if (!controller.signal.aborted) setAnswer({ q, hits: [], cursor: null, failed: true })
            },
        )
        return () => controller.abort()
    }, [remote, viewId, q, attempt])

    const shown = q && answer?.q === q ? answer : null

    const loadMore = (from: Answer) => {
        if (!remote || !from.cursor) return
        const cursor = from.cursor
        setFetching(cursor)
        remote.searchAdvanced(nameQuery(viewId, from.q, cursor)).then(
            (page) => setAnswer((prev) => (prev?.q === from.q && prev.cursor === cursor
                ? { ...prev, hits: [...prev.hits, ...(page.hits ?? [])], cursor: page.cursor ?? null, failed: false }
                : prev)),
            // The hits so far stay, and so does the cursor: Load more tries again.
            () => setAnswer((prev) => (prev?.q === from.q ? { ...prev, failed: true } : prev)),
        ).finally(() => setFetching((now) => (now === cursor ? null : now)))
    }

    return (
        <aside
            aria-label="Search names"
            className="absolute top-16 right-4 z-30 w-[380px] max-w-[calc(100%-2rem)] max-h-[calc(100%-6rem)] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated/98 backdrop-blur-xl shadow-xl overflow-hidden"
        >
            <div className="flex-shrink-0 p-3 space-y-2 border-b border-glass-border/60">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-display font-semibold text-ink">Search names</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close name search"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden />
                    <input
                        autoFocus
                        type="text"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Find an entity by name…"
                        aria-label="Name"
                        className="input w-full pl-9 py-1.5 text-sm"
                    />
                </div>
                <p className="text-[11px] leading-snug text-indigo-700 dark:text-indigo-300">{AT_REVISION_READS}</p>
            </div>

            {q && (
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2">
                    {!shown && (
                        <div className="flex items-center gap-2 px-2 py-3 text-xs text-ink-muted">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Searching names…
                        </div>
                    )}
                    {shown?.hits.map((hit, i) => (
                        <SearchHitRow
                            key={hit.node.urn}
                            hit={hit}
                            index={i}
                            query={shown.q}
                            onReveal={(urn, path) => void onRevealNode(urn, path)}
                        />
                    ))}
                    {shown && !shown.failed && shown.hits.length === 0 && (
                        <p className="px-2 py-3 text-xs text-ink-muted">No name matches “{shown.q}”.</p>
                    )}
                    {shown?.failed && (
                        <p role="alert" className="px-2 py-2 text-xs text-rose-600 dark:text-rose-400">
                            The names couldn’t be searched just now.{' '}
                            {!shown.cursor && (
                                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline">
                                    Try again
                                </button>
                            )}
                        </p>
                    )}
                    {shown?.cursor && (
                        <button
                            type="button"
                            onClick={() => loadMore(shown)}
                            disabled={fetching === shown.cursor}
                            className="btn btn-ghost btn-sm w-full mt-1 disabled:opacity-60"
                        >
                            {fetching === shown.cursor && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
                            Load more
                        </button>
                    )}
                </div>
            )}
        </aside>
    )
}
