/**
 * useDisplayRuleEngine — recomputes the Property Manager's display-rule
 * match sets and publishes them to ``displayRuleMatchStore`` so the
 * canvas can render tag chips on matched nodes.
 *
 * Mounted once by the Context View. It watches:
 *   - the persisted display rules (referenceModelStore.displayRules),
 *   - the active viewId,
 *   - the canvas node set (so rules re-evaluate after lazy-load / edits).
 *
 * On any change it debounces, then evaluates every ENABLED rule via
 * ``evaluateDisplayRule`` (view-scoped ``searchAdvanced``, independent of
 * the live Advanced-Search highlight) and writes each rule's matched
 * URNs into the match store. Disabled/deleted rules are pruned so their
 * chips disappear immediately.
 */
import { useEffect, useMemo, useRef } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useCanvasStore } from '@/store/canvas'
import { useDisplayRules, useReferenceModelStore } from '@/store/referenceModelStore'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import type { Predicate } from '@/types/search'

import { evaluateDisplayRule, resolveScopeRootUrns } from '@/services/displayRuleEval'


/** Debounce window before (re-)evaluating rules after a dependency
 *  change. Keeps rapid canvas mutations (expand/collapse bursts) from
 *  firing a search per frame. */
const DEBOUNCE_MS = 350


export function useDisplayRuleEngine(viewId: string | null | undefined): void {
    const provider = useGraphProvider()
    const rules = useDisplayRules()
    const layers = useReferenceModelStore((s) => s.layers)
    // Node count is only a cheap trigger to RE-DERIVE the scope roots; the
    // heavy rule searches below key on the resolved-roots signature, not on
    // node count, so they don't re-fire on every expand/collapse or
    // streaming-load tick (the view-scoped search already covers descendants).
    const nodeCount = useCanvasStore((s) => s.nodes.length)

    // Signature of the resolved view-scope roots. Recomputed cheaply
    // (O(nodes)) when the canvas/layers change, but its VALUE only changes
    // when the roots actually change (initial roots load / layer-assignment
    // edit) — which is exactly when rules need re-evaluating.
    const scopeSignature = useMemo(
        () => resolveScopeRootUrns().slice().sort().join(''),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [viewId, nodeCount, layers],
    )

    const setRuleMatches = useDisplayRuleMatchStore((s) => s.setRuleMatches)
    const setRuleMeta = useDisplayRuleMatchStore((s) => s.setRuleMeta)
    const retainRules = useDisplayRuleMatchStore((s) => s.retainRules)
    const clear = useDisplayRuleMatchStore((s) => s.clear)

    // Keep the visual metadata snapshot in sync synchronously so chips
    // re-color / disappear the instant a rule is edited, without waiting
    // for the debounced re-evaluation.
    useEffect(() => {
        setRuleMeta(rules)
        retainRules(rules.filter((r) => r.enabled).map((r) => r.id))
    }, [rules, setRuleMeta, retainRules])

    useEffect(() => {
        if (!viewId) {
            clear()
            return
        }
        const enabled = rules.filter((r) => r.enabled)
        if (enabled.length === 0) return

        const controller = new AbortController()
        const timer = setTimeout(() => {
            // Evaluate each enabled rule independently so one slow/failed
            // rule doesn't block the others' chips from appearing.
            for (const rule of enabled) {
                evaluateDisplayRule(
                    provider,
                    viewId,
                    rule.predicate as Predicate,
                    controller.signal,
                    // Progressive paint: apply each page as it arrives so
                    // chips for big rules show up before pagination finishes.
                    (urns) => {
                        if (!controller.signal.aborted) setRuleMatches(rule.id, urns)
                    },
                )
                    .then((urns) => {
                        if (controller.signal.aborted) return
                        setRuleMatches(rule.id, urns)
                    })
                    .catch((err) => {
                        if (controller.signal.aborted) return
                        // Non-fatal: leave the rule's previous matches in
                        // place and surface the failure for support.
                        console.warn('[displayRuleEngine] rule eval failed', rule.id, err)
                    })
            }
        }, DEBOUNCE_MS)

        return () => {
            controller.abort()
            clearTimeout(timer)
        }
        // Heavy searches re-run only when the rule set or the resolved scope
        // roots change — NOT on every node-count change (see scopeSignature).
    }, [viewId, rules, scopeSignature, provider, setRuleMatches, clear])

    // Wipe the match store on unmount so a remount (view switch) starts
    // from a clean slate.
    const clearRef = useRef(clear)
    clearRef.current = clear
    useEffect(() => () => clearRef.current(), [])
}
