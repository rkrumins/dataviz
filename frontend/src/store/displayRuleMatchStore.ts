/**
 * displayRuleMatchStore — computed (non-persisted) display-rule results:
 * which on-screen entities each rule tags, and how many entities it
 * matches in the whole view.
 *
 * The persisted rules themselves live in the view blueprint
 * (referenceModelStore.displayRules). ``useDisplayRuleEngine`` fills this
 * store from the server, two ways:
 *
 *   - membership — for the entities the canvas has loaded, which rules
 *     match them (``POST /search/membership``); a chip only ever needs
 *     the answer for its own row, never every entity a rule matches;
 *   - counts — each rule's exact total in the view (``POST
 *     /search/counts``), however many entities that is.
 *
 * Consumers (FlatTreeItem and other canvas rows) subscribe via
 * ``useDisplayRuleTags(urn)`` for its chips and ``useDisplayRuleLook(urn)``
 * for its tint and frame; a row re-renders only when THAT entity's answer
 * changes — cheap inside a virtualized list of hundreds of rows.
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { RuleCount } from '@/services/ruleCounts'
import type { DisplayRuleConfig, DisplayRuleStyle } from '@/types/schema'


/** The visual payload a matched node needs to render one chip. */
export interface DisplayRuleTag {
    id: string
    name: string
    color: string
    /** Optional Lucide icon name rendered on the chip. */
    icon?: string
    /** How the rule paints what it matches; absent, its chip alone. */
    style?: DisplayRuleStyle
}

/** How one entity's card is painted by the rules that match it: the first
 *  rule in the list with a tint gives the tint, the first with a frame the
 *  frame. Empty when none paints it. */
export interface DisplayRuleLook {
    fillColor?: string
    frameColor?: string
    frameKind?: 'solid' | 'dashed'
}


interface DisplayRuleMatchState {
    /** ruleId → the loaded entities that rule matches. */
    matchUrnsByRule: ReadonlyMap<string, ReadonlySet<string>>
    /** ruleId → how many entities it matches in the whole view (exact
     *  once ``complete``). */
    countsByRule: ReadonlyMap<string, RuleCount>
    /** Snapshot of the enabled rules' visual metadata, kept here so the
     *  per-URN selector can build chips without reading the blueprint
     *  store (avoids cross-store subscription churn). Ordered for stable
     *  chip rendering. */
    ruleMeta: ReadonlyArray<DisplayRuleTag>
    /** Why the last ask failed — which entities the rules tag, or how many
     *  they match — in words; null when it didn't. Shown with a Retry. */
    membershipError: string | null
    countsError: string | null
    /** Bumped by ``retryChecks`` to ask both again. */
    retryToken: number

    /** Fold in one membership answer: for each rule asked about, the
     *  evaluated URNs it matches now — and no longer the others. */
    applyMembership: (
        ruleIds: ReadonlyArray<string>,
        evaluated: ReadonlyArray<string>,
        matches: Readonly<Record<string, ReadonlyArray<string>>>,
    ) => void
    /** Publish the rules' totals. */
    setCounts: (counts: ReadonlyMap<string, RuleCount>) => void
    /** Drop a rule's matches entirely (rule deleted / disabled). */
    clearRule: (ruleId: string) => void
    /** Publish the current enabled-rule visual metadata snapshot. */
    setRuleMeta: (rules: ReadonlyArray<DisplayRuleConfig>) => void
    /** Prune any match sets / counts whose ruleId is not in the keep-set. */
    retainRules: (keepIds: Iterable<string>) => void
    setMembershipError: (error: string | null) => void
    setCountsError: (error: string | null) => void
    /** Ask again: every loaded entity, and every rule's count. */
    retryChecks: () => void
    /** Wipe everything (view switch / unmount). */
    clear: () => void
}


const EMPTY_MATCHES: ReadonlyMap<string, ReadonlySet<string>> = new Map()
const EMPTY_COUNTS: ReadonlyMap<string, RuleCount> = new Map()
const EMPTY_META: ReadonlyArray<DisplayRuleTag> = Object.freeze([])
const EMPTY_TAGS: ReadonlyArray<DisplayRuleTag> = Object.freeze([])
const EMPTY_LOOK: DisplayRuleLook = Object.freeze({})


export const useDisplayRuleMatchStore = create<DisplayRuleMatchState>((set) => ({
    matchUrnsByRule: EMPTY_MATCHES,
    countsByRule: EMPTY_COUNTS,
    ruleMeta: EMPTY_META,
    membershipError: null,
    countsError: null,
    retryToken: 0,

    applyMembership: (ruleIds, evaluated, matches) => {
        set((s) => {
            const next = new Map(s.matchUrnsByRule)
            for (const id of ruleIds) {
                const updated = new Set(next.get(id) ?? [])
                for (const urn of evaluated) updated.delete(urn)
                for (const urn of matches[id] ?? []) updated.add(urn)
                next.set(id, updated)
            }
            return { matchUrnsByRule: next }
        })
    },

    setCounts: (counts) => set({ countsByRule: counts }),

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
                .map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon, style: r.style })),
        })
    },

    retainRules: (keepIds) => {
        const keep = new Set(keepIds)
        set((s) => {
            const matches = new Map([...s.matchUrnsByRule].filter(([id]) => keep.has(id)))
            const counts = new Map([...s.countsByRule].filter(([id]) => keep.has(id)))
            const changed = matches.size !== s.matchUrnsByRule.size
                || counts.size !== s.countsByRule.size
            return changed ? { matchUrnsByRule: matches, countsByRule: counts } : {}
        })
    },

    setMembershipError: (error) => set({ membershipError: error }),
    setCountsError: (error) => set({ countsError: error }),
    retryChecks: () => set((s) => ({
        membershipError: null, countsError: null, retryToken: s.retryToken + 1,
    })),

    clear: () => set({
        matchUrnsByRule: EMPTY_MATCHES, countsByRule: EMPTY_COUNTS, ruleMeta: EMPTY_META,
        membershipError: null, countsError: null,
    }),
}))


/**
 * Subscribe to the display-rule chips for a single node URN. The tags are
 * compared element by element, so a row re-renders only when its own tags
 * change — not whenever any rule's answer for any other row lands.
 */
export function useDisplayRuleTags(urn: string | undefined): ReadonlyArray<DisplayRuleTag> {
    return useDisplayRuleMatchStore(useShallow((s) => tagsOf(s, urn)))
}


function tagsOf(s: DisplayRuleMatchState, urn: string | undefined): ReadonlyArray<DisplayRuleTag> {
    if (!urn || s.ruleMeta.length === 0) return EMPTY_TAGS
    const tags: DisplayRuleTag[] = []
    for (const meta of s.ruleMeta) {
        // A rule styled without its chip paints the card and says nothing.
        if (meta.style?.chip === false) continue
        if (s.matchUrnsByRule.get(meta.id)?.has(urn)) tags.push(meta)
    }
    return tags.length === 0 ? EMPTY_TAGS : tags
}


/**
 * Subscribe to how a single node URN's card is painted. Compared field by
 * field, so a row re-renders only when its own tint or frame changes.
 */
export function useDisplayRuleLook(urn: string | undefined): DisplayRuleLook {
    return useDisplayRuleMatchStore(useShallow((s) => lookOf(s, urn)))
}


function lookOf(s: DisplayRuleMatchState, urn: string | undefined): DisplayRuleLook {
    if (!urn || s.ruleMeta.length === 0) return EMPTY_LOOK
    let fillColor: string | undefined
    let frameColor: string | undefined
    let frameKind: DisplayRuleLook['frameKind']
    for (const meta of s.ruleMeta) {
        const style = meta.style
        if (!style || (!style.fill && !style.frame)) continue
        if (!s.matchUrnsByRule.get(meta.id)?.has(urn)) continue
        if (style.fill && fillColor === undefined) fillColor = meta.color
        if (style.frame && frameKind === undefined) {
            frameKind = style.frame
            frameColor = meta.color
        }
        if (fillColor !== undefined && frameKind !== undefined) break
    }
    if (fillColor === undefined && frameKind === undefined) return EMPTY_LOOK
    return { fillColor, frameColor, frameKind }
}


/** One rule's total in the view — undefined until its count starts. */
export function useRuleCount(ruleId: string | undefined): RuleCount | undefined {
    return useDisplayRuleMatchStore((s) => (ruleId ? s.countsByRule.get(ruleId) : undefined))
}