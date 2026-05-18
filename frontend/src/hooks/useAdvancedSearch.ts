/**
 * State machine + provider orchestration for the SearchMapPanel.
 *
 * Three responsibilities:
 *   1. Hold the current view: idle → templateSelected → running → results,
 *      with the active template inputs / parsed query alongside.
 *   2. Talk to the backend through RemoteGraphProvider.searchAdvanced,
 *      with abort-on-restart so a stale request can never overwrite a
 *      fresh one (e.g. user re-runs while a slow query is still in flight).
 *   3. Track the scope drill stack — when the user clicks "Drill into
 *      Customers", we push a scope frame; the breadcrumb pops it.
 *
 * Drill semantics: every drill re-issues the same predicate with
 * `scope.rootUrns` set to the bucket's `ancestorUrn`. The hit
 * subtree is the new universe; the same template applies inside it.
 * This is the "orient before drill" UX from the brief.
 *
 * Not stored: the JSON-builder/Advanced tab state. That belongs to a
 * separate dev surface (the existing AdvancedSearchDevPanel) — keeping
 * the production hook focused on the template-driven path.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type {
    SearchQuery,
    SearchResultPage,
    SearchScope,
} from '@/types/search'

import {
    defaultInputs,
    findTemplate,
    type SearchTemplate,
} from '@/components/canvas/search/searchTemplates'


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PanelView =
    | { kind: 'idle' }                                          // template picker
    | { kind: 'templateSelected'; template: SearchTemplate;     // params form
        inputs: Record<string, string | number> }
    | { kind: 'running'; template: SearchTemplate;               // spinner
        inputs: Record<string, string | number>;
        query: SearchQuery; startedAt: number }
    | { kind: 'results'; template: SearchTemplate;               // cards/rows
        inputs: Record<string, string | number>;
        query: SearchQuery; result: SearchResultPage;
        elapsedMs: number }
    | { kind: 'error'; template: SearchTemplate;                 // error card
        inputs: Record<string, string | number>;
        query: SearchQuery; message: string;
        elapsedMs: number }

/** One frame on the drill stack — used to render the scope breadcrumb. */
export interface ScopeFrame {
    /** URN of the ancestor we drilled into. Empty string at the root. */
    urn: string
    /** Human-readable label for the breadcrumb. */
    label: string
    /** Entity type, used to colour-tint the breadcrumb chip. */
    entityType: string
}

const ROOT_FRAME: ScopeFrame = { urn: '', label: 'All', entityType: '' }


export interface UseAdvancedSearchResult {
    view: PanelView
    scope: ScopeFrame[]
    /** True when no template has been selected yet. */
    isIdle: boolean
    /** Pick a template — moves the view to `templateSelected` with default inputs. */
    selectTemplate: (templateId: string) => void
    /** Update one input on the active template. */
    setInput: (name: string, value: string | number) => void
    /** Pop back to the template picker. */
    resetTemplate: () => void
    /** Run the search with the current template + inputs. */
    run: () => Promise<void>
    /** Drill into an aggregate bucket — pushes a scope frame and re-runs. */
    drillInto: (bucket: { ancestorUrn: string; ancestorDisplayName: string;
                          ancestorEntityType: string }) => void
    /** Pop scope frames to the given index (0 = root). */
    popScope: (toIndex: number) => void
    /** Abort any in-flight query and return to idle. */
    cancel: () => void
}


// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAdvancedSearch(): UseAdvancedSearchResult {
    const provider = useGraphProvider()
    const [view, setView] = useState<PanelView>({ kind: 'idle' })
    const [scope, setScope] = useState<ScopeFrame[]>([ROOT_FRAME])
    const abortRef = useRef<AbortController | null>(null)

    // Cancel any in-flight request when the hook unmounts (panel closed
    // mid-query). Otherwise the resolved promise would set state on an
    // unmounted component.
    useEffect(() => () => abortRef.current?.abort(), [])

    const selectTemplate = useCallback((templateId: string) => {
        const t = findTemplate(templateId)
        setView({
            kind: 'templateSelected',
            template: t,
            inputs: defaultInputs(t),
        })
    }, [])

    const setInput = useCallback((name: string, value: string | number) => {
        setView((v) => {
            if (v.kind === 'idle' || v.kind === 'running') return v
            return { ...v, inputs: { ...v.inputs, [name]: value } }
        })
    }, [])

    const resetTemplate = useCallback(() => {
        abortRef.current?.abort()
        setView({ kind: 'idle' })
    }, [])

    const buildQueryWithScope = useCallback(
        (template: SearchTemplate, inputs: Record<string, string | number>,
         scopeStack: ScopeFrame[]): SearchQuery => {
            const query = template.build(inputs)
            // If we've drilled (non-root scope frames), inject the
            // current ancestor URN as the scope root. The template's
            // own scope (if any) wins for its own entityTypes/depth,
            // but root_urns gets overridden with the drill target.
            const drillFrame = scopeStack[scopeStack.length - 1]
            if (drillFrame && drillFrame.urn) {
                const scope: SearchScope = {
                    ...(query.scope ?? {}),
                    rootUrns: [drillFrame.urn],
                }
                return { ...query, scope }
            }
            return query
        },
        [],
    )

    const runWithInputs = useCallback(async (
        template: SearchTemplate,
        inputs: Record<string, string | number>,
        scopeStack: ScopeFrame[],
    ) => {
        if (!(provider instanceof RemoteGraphProvider)) {
            setView({
                kind: 'error', template, inputs,
                query: template.build(inputs),
                message:
                    'Active provider is not the remote backend — ' +
                    'advanced search only works against the live API.',
                elapsedMs: 0,
            })
            return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const query = buildQueryWithScope(template, inputs, scopeStack)
        const startedAt = performance.now()
        setView({ kind: 'running', template, inputs, query, startedAt })

        try {
            const result = await provider.searchAdvanced(query)
            if (controller.signal.aborted) return
            setView({
                kind: 'results', template, inputs, query, result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            setView({
                kind: 'error', template, inputs, query,
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
        }
    }, [provider, buildQueryWithScope])

    const run = useCallback(async () => {
        if (view.kind === 'idle' || view.kind === 'running') return
        await runWithInputs(view.template, view.inputs, scope)
    }, [view, scope, runWithInputs])

    const drillInto = useCallback((bucket: {
        ancestorUrn: string
        ancestorDisplayName: string
        ancestorEntityType: string
    }) => {
        if (view.kind !== 'results') return
        const nextScope: ScopeFrame[] = [
            ...scope,
            {
                urn: bucket.ancestorUrn,
                label: bucket.ancestorDisplayName,
                entityType: bucket.ancestorEntityType,
            },
        ]
        setScope(nextScope)
        // Re-run the same template + inputs but now scoped to the
        // bucket. The buildQueryWithScope helper injects scope.rootUrns.
        void runWithInputs(view.template, view.inputs, nextScope)
    }, [view, scope, runWithInputs])

    const popScope = useCallback((toIndex: number) => {
        const clamped = Math.max(0, Math.min(toIndex, scope.length - 1))
        if (clamped === scope.length - 1) return
        const nextScope = scope.slice(0, clamped + 1)
        setScope(nextScope)
        // If we have a query in flight or showing, re-run it at the
        // new scope so the displayed buckets/hits match the breadcrumb.
        if (view.kind === 'results' || view.kind === 'error') {
            void runWithInputs(view.template, view.inputs, nextScope)
        }
    }, [scope, view, runWithInputs])

    const cancel = useCallback(() => {
        abortRef.current?.abort()
        if (view.kind === 'running') {
            // Restore the form so the user can adjust + retry without
            // losing their inputs.
            setView({
                kind: 'templateSelected',
                template: view.template,
                inputs: view.inputs,
            })
        }
    }, [view])

    return {
        view,
        scope,
        isIdle: view.kind === 'idle',
        selectTemplate,
        setInput,
        resetTemplate,
        run,
        drillInto,
        popScope,
        cancel,
    }
}
