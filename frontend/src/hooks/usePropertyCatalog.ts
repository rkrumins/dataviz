/**
 * usePropertyCatalog — the view's exact property catalog, read as the
 * Properties tab opens and followed to the end (``services/propertyCatalog``).
 *
 * While a read runs, ``catalog`` is what it has found so far and
 * ``reading`` how far it has got. A refresh keeps showing the last complete
 * catalog until the new one is complete — a panel of exact numbers never
 * turns back into partial ones. The last complete catalog of each view is
 * kept for the session, so reopening the tab shows it at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useDraftDataKey } from '@/features/versioning/hooks/useDraftDataKey'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { followCatalog } from '@/services/propertyCatalog'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { useBranchStore } from '@/store/branchStore'
import type { SearchCatalogResult } from '@/types/search'


export interface PropertyCatalogState {
    /** The last complete catalog — or, before there is one, the read so far. */
    catalog: SearchCatalogResult | null
    /** How far a read that is still running has got, 0–100; null when none is. */
    reading: number | null
    error: string | null
    /** This view's catalog can't be read here (a share link, a provider
     *  without one). */
    unavailable: boolean
    /** Read the view again. */
    refresh: () => void
}


/** The last complete catalog, per provider and view (and the draft open: a
 *  draft's catalog is its own, never Published's). */
const lastComplete = new WeakMap<object, Map<string, SearchCatalogResult>>()

function remembered(provider: object, viewId: string): SearchCatalogResult | null {
    return lastComplete.get(provider)?.get(viewId) ?? null
}

function remember(provider: object, viewId: string, catalog: SearchCatalogResult): void {
    let byView = lastComplete.get(provider)
    if (!byView) lastComplete.set(provider, (byView = new Map()))
    byView.set(viewId, catalog)
}


interface ViewState {
    viewId: string
    complete: SearchCatalogResult | null
    running: SearchCatalogResult | null
    error: string | null
    refused: boolean
}


export function usePropertyCatalog(viewId: string): PropertyCatalogState {
    const provider = useGraphProvider()
    // On a draft the server's catalog is the draft's, so it is read again as
    // the draft changes — a bulk change window by window — showing the last
    // complete one until the new one is.
    const draftKey = useDraftDataKey()
    const branchId = useBranchStore((s) => s.currentBranchId) ?? ''
    const kept = `${branchId}|${viewId}`
    const [held, setHeld] = useState<ViewState | null>(null)
    // A refresh belongs to the view it was asked for — and to the read it
    // started: one the draft moving on starts reads what the server has.
    const [refreshOf, setRefreshOf] = useState({ viewId: '', n: 0 })
    const refreshed = useRef(refreshOf)

    useEffect(() => {
        if (!viewId || !(provider instanceof RemoteGraphProvider)) return
        const controller = new AbortController()
        const refresh = refreshOf !== refreshed.current && refreshOf.viewId === viewId && refreshOf.n > 0
        refreshed.current = refreshOf
        // Every update names its view: an answer for a view switched away
        // from never shows under the new one.
        const update = (next: (s: ViewState) => ViewState) => setHeld((s) => next(
            s && s.viewId === kept ? s : fresh(provider, kept)))
        followCatalog(provider, viewId, {
            signal: controller.signal,
            refresh,
            onUpdate: (answer) => {
                if (controller.signal.aborted) return
                if (answer.status === 'complete') remember(provider, kept, answer)
                update((s) => (answer.status === 'complete'
                    ? { ...s, complete: answer, running: null, error: null, refused: false }
                    : { ...s, running: answer, error: null }))
            },
        }).catch((e: unknown) => {
            if (controller.signal.aborted) return
            const status = httpStatusOf(e)
            const refused = status === 403 || status === 501
            update((s) => ({ ...s, running: null, refused,
                             error: refused ? null : (e as Error).message }))
        })
        return () => controller.abort()
        // ``kept`` is the view and the branch; ``draftKey`` how far the draft has got.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, kept, draftKey, refreshOf])

    const refresh = useCallback(
        () => setRefreshOf((r) => ({ viewId, n: r.viewId === viewId ? r.n + 1 : 1 })),
        [viewId],
    )
    const state = held && held.viewId === kept ? held : fresh(provider, kept)
    const { complete, running } = state
    const progress = running?.progress
    return {
        catalog: complete ?? running,
        reading: running
            ? (progress && progress.total > 0
                ? Math.min(99, Math.floor((progress.scanned / progress.total) * 100)) : 0)
            : null,
        error: state.error,
        unavailable: !(provider instanceof RemoteGraphProvider) || state.refused,
        refresh,
    }
}


function fresh(provider: object, viewId: string): ViewState {
    return { viewId, complete: remembered(provider, viewId), running: null,
             error: null, refused: false }
}
