/**
 * displayRuleMatchStore — computed (non-persisted) match sets for the
 * Property Manager's display-rule tag overlay.
 *
 * The persisted rules themselves live in the view blueprint
 * (referenceModelStore.displayRules). This store holds only the
 * *derived* "which URNs does each enabled rule currently match?" map,
 * recomputed by ``useDisplayRuleEngine`` whenever the rules or the
 * canvas data change. Keeping it separate from the blueprint mirrors how
 * ``searchStore`` keeps live match results out of the authoring state.
 *
 * Consumers (FlatTreeItem and other canvas rows) subscribe via
 * ``useDisplayRuleTags(urn)`` to get the chips for one node; the
 * selector re-renders a row only when THAT node's tag set changes —
 * cheap enough to call inside a virtualized list of hundreds of rows.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import type { DisplayRuleConfig } from '@/types/schema'


/** The visual payload a matched node needs to render one chip. */
export interface DisplayRuleTag {
    id: string
    name: string
    color: string
    /** Optional Lucide icon name rendered on the chip. */
    icon?: string
}


interface DisplayRuleMatchState {
    /** ruleId → set of node URNs that rule currently matches. */
    matchUrnsByRule: ReadonlyMap<string, ReadonlySet<string>>
    /** Snapshot of the enabled rules' visual metadata, kept here so the
     *  per-URN selector can build chips without reading the blueprint
     *  store (avoids cross-store subscription churn). Ordered for stable
     *  chip rendering. */
    ruleMeta: ReadonlyArray<DisplayRuleTag>

    /** Replace one rule's match set (called per-rule by the engine). */
    setRuleMatches: (ruleId: string, urns: Iterable<string>) => void
    /** Drop a rule's matches entirely (rule deleted / disabled). */
    clearRule: (ruleId: string) => void
    /** Publish the current enabled-rule visual metadata snapshot. */
    setRuleMeta: (rules: ReadonlyArray<DisplayRuleConfig>) => void
    /** Prune any match sets / meta whose ruleId is not in the keep-set. */
    retainRules: (keepIds: Iterable<string>) => void
    /** Wipe everything (view switch / unmount). */
    clear: () => void
}


const EMPTY_MATCHES: ReadonlyMap<string, ReadonlySet<string>> = new Map()
const EMPTY_META: ReadonlyArray<DisplayRuleTag> = Object.freeze([])
const EMPTY_TAGS: ReadonlyArray<DisplayRuleTag> = Object.freeze([])


export const useDisplayRuleMatchStore = create<DisplayRuleMatchState>((set) => ({
    matchUrnsByRule: EMPTY_MATCHES,
    ruleMeta: EMPTY_META,

    setRuleMatches: (ruleId, urns) => {
        set((s) => {
            const next = new Map(s.matchUrnsByRule)
            next.set(ruleId, new Set(urns))
            return { matchUrnsByRule: next }
        })
    },

    clearRule: (ruleId) => {
        set((s) => {
            if (!s.matchUrnsByRule.has(ruleId)) return {}
            const next = new Map(s.matchUrnsByRule)
            next.delete(ruleId)
            return { matchUrnsByRule: next }
        })
    },

    setRuleMeta: (rules) => {
        set({
            ruleMeta: rules
                .filter((r) => r.enabled)
                .map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon })),
        })
    },

    retainRules: (keepIds) => {
        const keep = new Set(keepIds)
        set((s) => {
            let changed = false
            const next = new Map(s.matchUrnsByRule)
            for (const id of next.keys()) {
                if (!keep.has(id)) {
                    next.delete(id)
                    changed = true
                }
            }
            return changed ? { matchUrnsByRule: next } : {}
        })
    },

    clear: () => set({ matchUrnsByRule: EMPTY_MATCHES, ruleMeta: EMPTY_META }),
}))


/**
 * Subscribe to the display-rule chips for a single node URN. Returns a
 * stable empty array when the node matches no enabled rule (so rows that
 * never match don't re-render on unrelated updates).
 *
 * The membership test runs against every enabled rule's match set; with
 * a handful of rules and Set lookups this is O(rules) per row, which is
 * negligible versus the row's own render cost.
 */
export function useDisplayRuleTags(urn: string | undefined): ReadonlyArray<DisplayRuleTag> {
    const matchUrnsByRule = useDisplayRuleMatchStore((s) => s.matchUrnsByRule)
    const ruleMeta = useDisplayRuleMatchStore((s) => s.ruleMeta)
    return useMemo(() => {
        if (!urn || ruleMeta.length === 0) return EMPTY_TAGS
        const tags: DisplayRuleTag[] = []
        for (const meta of ruleMeta) {
            const set = matchUrnsByRule.get(meta.id)
            if (set && set.has(urn)) tags.push(meta)
        }
        return tags.length === 0 ? EMPTY_TAGS : tags
    }, [urn, ruleMeta, matchUrnsByRule])
}


/** Total matched-node count for one rule (drives the rule-card count). */
export function useRuleMatchCount(ruleId: string | undefined): number {
    return useDisplayRuleMatchStore((s) =>
        ruleId ? s.matchUrnsByRule.get(ruleId)?.size ?? 0 : 0,
    )
}
