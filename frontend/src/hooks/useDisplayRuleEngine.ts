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
 *   - On a canvas that draws them (``lines``): which of the relationships
 *     it has loaded does each rule that styles relationships match? (The
 *     same membership, ≤ 1,000 relationships a request, each by its id and
 *     its ends; a relationship rule's count is its Connections search's.)
 *
 * Both are re-asked when a rule's criteria, the enabled set, the view's
 * layers or the open draft change (``useDraftDataKey``: a save, a bulk change
 * window by window) — never for a rename or a new colour. The server resolves
 * the view's scope for both, and answers a draft as it stands; an entity
 * outside the scope is never tagged.
 */
import { useEffect, useMemo, useRef } from 'react'

import { readableSearchError } from '@/components/canvas/search/panel/errorPaths'
import { useDraftDataKey } from '@/features/versioning/hooks/useDraftDataKey'
import { useViewIsContainmentEdge } from '@/hooks/useViewSchema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { rideOut } from '@/services/rideOut'
import { countRules } from '@/services/ruleCounts'
import { type LineageEdge, useCanvasStore } from '@/store/canvas'
import { useDisplayRules, useReferenceModelStore } from '@/store/referenceModelStore'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { normalizeEdgeType } from '@/store/schema'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate, SearchMembershipResult } from '@/types/search'


/** Debounce window before asking, so bursts of loads and edits (an
 *  expand-all, typing in a rule) settle into one request. */
const DEBOUNCE_MS = 150

/** The server's limits per membership request. */
const URNS_PER_REQUEST = 1000
const EDGES_PER_REQUEST = 1000
const RULES_PER_REQUEST = 32

const NO_EDGES: readonly LineageEdge[] = []

export interface DisplayRuleEngineOptions {
    /** The canvas draws relationships' lines, so its relationship rules are
     *  asked about the relationships it has loaded. */
    lines?: boolean
}


export function useDisplayRuleEngine(
    viewId: string | null | undefined, { lines = false }: DisplayRuleEngineOptions = {},
): void {
    const provider = useGraphProvider()
    const rules = useDisplayRules()
    const layers = useReferenceModelStore((s) => s.layers)
    const nodes = useCanvasStore((s) => s.nodes)
    const edges = useCanvasStore((s) => (lines ? s.edges : NO_EDGES))
    const isContainmentEdge = useViewIsContainmentEdge()

    const setRuleMeta = useDisplayRuleMatchStore((s) => s.setRuleMeta)
    const retainRules = useDisplayRuleMatchStore((s) => s.retainRules)
    const applyMembership = useDisplayRuleMatchStore((s) => s.applyMembership)
    const applyEdgeMembership = useDisplayRuleMatchStore((s) => s.applyEdgeMembership)
    const setCounts = useDisplayRuleMatchStore((s) => s.setCounts)
    const setMembershipError = useDisplayRuleMatchStore((s) => s.setMembershipError)
    const setCountsError = useDisplayRuleMatchStore((s) => s.setCountsError)
    const setMembershipNote = useDisplayRuleMatchStore((s) => s.setMembershipNote)
    const retryToken = useDisplayRuleMatchStore((s) => s.retryToken)
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
    const entityRules = useMemo(() => askable.filter((r) => !stylesLines(r)), [askable])
    const lineRules = useMemo(() => askable.filter(stylesLines), [askable])
    // What the answers depend on: which rules, with which criteria, in which
    // view (and its layers) and on which state of the draft open — not a
    // rule's name, colour or icon. A draft's chips and counts are its own, so
    // they are asked again as it changes (a save, a bulk change window by window).
    const draftKey = useDraftDataKey()
    const signature = useMemo(
        () => JSON.stringify([viewId, enabled.map((r) => [r.id, r.target, r.predicate]), layers, draftKey]),
        [viewId, enabled, layers, draftKey],
    )

    // The entities, and the relationships, already answered for the current signature.
    const answered = useRef<{ signature: string; urns: Set<string> }>({
        signature: '', urns: new Set(),
    })
    const answeredEdges = useRef<{ signature: string; ids: Set<string> }>({
        signature: '', ids: new Set(),
    })

    // Membership: every loaded entity, once; later ones as they load.
    useEffect(() => {
        if (!viewId || !(provider instanceof RemoteGraphProvider) || entityRules.length === 0) return
        if (answered.current.signature !== signature) {
            answered.current = { signature, urns: new Set() }
            setMembershipNote(null)
        }
        const done = answered.current.urns
        const pending = [...new Set(nodes.map((n) => n.id).filter((u) => u && !done.has(u)))]
        if (pending.length === 0) return

        const controller = new AbortController()
        const timer = setTimeout(() => {
            void askInBatches(pending, URNS_PER_REQUEST, entityRules, controller.signal, {
                ask: (batch, group) => provider.searchMembership({
                    scope: { viewId, scopeMode: 'view' }, items: group.map(asItem), urns: batch,
                }, { signal: controller.signal }),
                apply: (batch, group, answer) => applyMembership(group.map((r) => r.id), batch, answer.matches),
                done: (batch) => { for (const urn of batch) done.add(urn) },
                setNote: setMembershipNote,
                setError: setMembershipError,
            })
        }, DEBOUNCE_MS)
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
    }, [viewId, provider, signature, entityRules, nodes, applyMembership, setMembershipError,
        setMembershipNote, retryToken])

    // Relationships: every loaded one the canvas draws as a line, once; later
    // ones as they load. Containment is drawn as nesting, never styled.
    useEffect(() => {
        if (!viewId || !(provider instanceof RemoteGraphProvider) || lineRules.length === 0) return
        if (answeredEdges.current.signature !== signature) {
            answeredEdges.current = { signature, ids: new Set() }
        }
        const done = answeredEdges.current.ids
        const pending = [...new Map(edges
            .filter((e) => e.id && !done.has(e.id) && !e.data?.isAggregated
                && !isContainmentEdge(normalizeEdgeType(e)))
            .map((e) => [e.id, e])).values()]
        if (pending.length === 0) return

        const controller = new AbortController()
        const timer = setTimeout(() => {
            void askInBatches(pending, EDGES_PER_REQUEST, lineRules, controller.signal, {
                ask: (batch, group) => provider.searchMembership({
                    scope: { viewId, scopeMode: 'view' }, items: group.map(asItem),
                    edges: batch.map((e) => ({ id: e.id, source: e.source, target: e.target })),
                }, { signal: controller.signal }),
                apply: (batch, group, answer) => applyEdgeMembership(
                    group.map((r) => r.id), batch.map((e) => e.id), answer.edgeMatches ?? {}),
                done: (batch) => { for (const e of batch) done.add(e.id) },
                setNote: setMembershipNote,
                setError: setMembershipError,
            })
        }, DEBOUNCE_MS)
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
    }, [viewId, provider, signature, lineRules, edges, isContainmentEdge, applyEdgeMembership,
        setMembershipError, setMembershipNote, retryToken])

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
            }).then(() => {
                if (!controller.signal.aborted) setCountsError(null)
            }).catch((err) => {
                if (controller.signal.aborted) return
                setCountsError(readable(err))
            })
        }, DEBOUNCE_MS)
        return () => {
            controller.abort()
            clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewId, provider, signature, setCounts, retryToken])

    // Wipe the store on unmount so a remount (view switch) starts clean.
    const clearRef = useRef(clear)
    useEffect(() => {
        clearRef.current = clear
    }, [clear])
    useEffect(() => () => clearRef.current(), [])
}


function readable(err: unknown): string {
    return readableSearchError(err instanceof Error ? err.message : String(err))
}


/**
 * Ask about ``pending`` (entities or relationships), ``perRequest`` at a
 * time, ≤ 32 rules a request, folding each answer in as it lands. A batch
 * that fails keeps its previous answers and is asked about again on the
 * next change — or on Retry, which the rule list offers with why it failed.
 */
async function askInBatches<T>(
    pending: readonly T[],
    perRequest: number,
    rules: readonly DisplayRuleConfig[],
    signal: AbortSignal,
    how: {
        ask: (batch: T[], group: DisplayRuleConfig[]) => Promise<SearchMembershipResult>
        apply: (batch: T[], group: DisplayRuleConfig[], answer: SearchMembershipResult) => void
        done: (batch: T[]) => void
        setNote: (note: string | null) => void
        setError: (error: string | null) => void
    },
): Promise<void> {
    for (let i = 0; i < pending.length; i += perRequest) {
        const batch = pending.slice(i, i + perRequest)
        for (let j = 0; j < rules.length; j += RULES_PER_REQUEST) {
            const group = rules.slice(j, j + RULES_PER_REQUEST)
            try {
                // The graph busy or failing over: asked again, for minutes.
                const answer = await rideOut(() => how.ask(batch, group), signal)
                if (signal.aborted) return
                how.apply(batch, group, answer)
                // On a draft, why some answers on what it changed are Published's.
                if (answer.notes?.length) how.setNote(answer.notes[0])
            } catch (err) {
                if (signal.aborted) return
                how.setError(readable(err))
                return
            }
        }
        how.done(batch)
    }
    how.setError(null)
}


/** A rule that styles relationships' lines: its predicate a Connections search. */
function stylesLines(rule: DisplayRuleConfig): boolean {
    return rule.target === 'relationships'
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
