/**
 * useDisplayRuleEngine — answers the Property Manager's display rules for
 * the canvas and publishes them to ``displayRuleMatchStore``.
 *
 * Mounted once per canvas. Two questions, two answers from the server:
 *
 *   - Which of the entities the canvas has loaded does each enabled rule
 *     tag? (``POST /search/membership``, ≤ 1,000 entities × ≤ 32 rules a
 *     request.) Each entity is asked about once per rule set; entities
 *     that load later are asked about as they arrive. The chips only ever
 *     need these answers — nothing downloads every entity a rule matches,
 *     so a rule tagging millions of entities costs what one tagging ten
 *     does.
 *   - How many entities does each rule match in the whole view?
 *     (``POST /search/counts``, followed to an exact total.)
 *
 * Both are re-asked when a rule's criteria, the enabled set or the view's
 * layers change — never for a rename or a new colour. The server resolves
 * the view's scope for both; an entity outside it is never tagged.
 */
import { useEffect, useMemo, useRef } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules } from '@/services/ruleCounts'
import { useCanvasStore } from '@/store/canvas'
import { useDisplayRules, useReferenceModelStore } from '@/store/referenceModelStore'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'


/** Debounce window before asking, so bursts of loads and edits (an
 *  expand-all, typing in a rule) settle into one request. */
const DEBOUNCE_MS = 150

/** The server's limits per membership request. */
const URNS_PER_REQUEST = 1000
const RULES_PER_REQUEST = 32


export function useDisplayRuleEngine(viewId: string | null | undefined): void {
    const provider = useGraphProvider()
    const rules = useDisplayRules()
    const layers = useReferenceModelStore((s) => s.layers)
    const nodes = useCanvasStore((s) => s.nodes)

    const setRuleMeta = useDisplayRuleMatchStore((s) => s.setRuleMeta)
    const retainRules = useDisplayRuleMatchStore((s) => s.retainRules)
    const applyMembership = useDisplayRuleMatchStore((s) => s.applyMembership)
    const setCounts = useDisplayRuleMatchStore((s) => s.setCounts)
    const clear = useDisplayRuleMatchStore((s) => s.clear)

    // Keep the visual metadata snapshot in sync synchronously so chips
    // re-color / disappear the instant a rule is edited, without waiting
    // for the next answer.
    useEffect(() => {
        setRuleMeta(rules)
        retainRules(rules.filter((r) => r.enabled).map((r) => r.id))
    }, [rules, setRuleMeta, retainRules])

    const enabled = useMemo(() => rules.filter((r) => r.enabled), [rules])
    const askable = useMemo(() => enabled.filter(canAsk), [enabled])
    // What the answers depend on: which rules, with which criteria, in which
    // view (and its layers) — not a rule's name, colour or icon.
    const signature = useMemo(
        () => JSON.stringify([viewId, enabled.map((r) => [r.id, r.predicate]), layers]),
        [viewId, enabled, layers],
    )

    // The entities already answered for the current signature.
    const answered = useRef<{ signature: string; urns: Set<string> }>({
        signature: '', urns: new Set(),
    })

    // Membership: every loaded entity, once; later ones as they load.
    useEffect(() => {
        if (!viewId || !(provider instanceof RemoteGraphProvider) || askable.length === 0) return
        if (answered.current.signature !== signature) {
            answered.current = { signature, urns: new Set() }
        }
        const done = answered.current.urns
        const pending = [...new Set(nodes.map((n) => n.id).filter((u) => u && !done.has(u)))]
        if (pending.length === 0) return

        const controller = new AbortController()
        const timer = setTimeout(() => {
            void (async () => {
                for (let i = 0; i < pending.length; i += URNS_PER_REQUEST) {
                    const batch = pending.slice(i, i + URNS_PER_REQUEST)
                    for (let j = 0; j < askable.length; j += RULES_PER_REQUEST) {
                        const group = askable.slice(j, j + RULES_PER_REQUEST)
                        try {
                            const answer = await provider.searchMembership({
                                scope: { viewId, scopeMode: 'view' },
                                items: group.map(asItem),
                                urns: batch,
                            }, { signal: controller.signal })
                            if (controller.signal.aborted) return
                            applyMembership(group.map((r) => r.id), batch, answer.matches)
                        } catch (err) {
                            if (controller.signal.aborted) return
                            // Non-fatal: the batch keeps its previous chips and
                            // is asked about again on the next change.
                            console.warn('[displayRuleEngine] membership failed', err)
                            return
                        }
                    }
                    for (const urn of batch) done.add(urn)
                }
            })()
        }, DEBOUNCE_MS)
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
    }, [viewId, provider, signature, askable, nodes, applyMembership])

    // Counts: each rule's exact total in the view. A rule that can't be asked
    // about reads as one that can't be counted, and why.
    useEffect(() => {
        if (!viewId || !(provider instanceof RemoteGraphProvider) || enabled.length === 0) return
        const refused = new Map(enabled.filter((r) => !canAsk(r)).map((r) => [r.id, {
            count: 0, complete: true, percent: 100,
            error: r.invalid ?? 'This rule has no criteria to match.',
        }]))
        if (askable.length === 0) {
            setCounts(refused)
            return
        }
        const controller = new AbortController()
        const timer = setTimeout(() => {
            countRules(provider, viewId, askable.map(asItem), {
                signal: controller.signal,
                onUpdate: (counts) => {
                    if (!controller.signal.aborted) setCounts(new Map([...counts, ...refused]))
                },
            }).catch((err) => {
                if (controller.signal.aborted) return
                console.warn('[displayRuleEngine] rule counts failed', err)
            })
        }, DEBOUNCE_MS)
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewId, provider, signature, setCounts])

    // Wipe the store on unmount so a remount (view switch) starts clean.
    const clearRef = useRef(clear)
    useEffect(() => {
        clearRef.current = clear
    }, [clear])
    useEffect(() => () => clearRef.current(), [])
}


/** Whether a rule can be asked about at all: not one the library flagged
 *  (``invalid`` — stored as given by a bundle import or a version restore),
 *  and one with criteria. Sent with the others, either would fail the whole
 *  batch it is asked in. */
function canAsk(rule: DisplayRuleConfig): boolean {
    return !rule.invalid && typeof rule.predicate === 'object' && rule.predicate !== null
}


function asItem(rule: DisplayRuleConfig): { id: string; predicate: Predicate } {
    const predicate = rule.predicate as Predicate
    return {
        id: rule.id,
        predicate: predicate.kind === 'group'
            ? predicate
            : { kind: 'group', op: 'and', children: [predicate] },
    }
}
