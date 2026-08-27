/**
 * localNodeIndex — the instant half of find-in-view.
 *
 * The server owns correctness: it is the only thing that can see the
 * entities this browser never downloaded, and it is where the view
 * boundary is enforced. But a round-trip per keystroke would make the
 * box feel dead, so every keystroke is answered locally first, from the
 * nodes already in hand, and the server's answer merges in behind it.
 *
 * Two rules keep the two halves from disagreeing in ways a user would
 * notice:
 *
 *   1. **The prefilter mirrors the server's operators.** ``contains`` is
 *      the server's CONTAINS, ``startsWith`` its STARTS WITH. A row that
 *      appears instantly must not vanish when the server replies.
 *   2. **Local coverage is a superset, never a different set.** The
 *      local haystack carries the same fields the server's
 *      ``searchableText`` does, plus a few it can't see (property keys,
 *      non-string values, entity type). Extra local hits are honest —
 *      they're really there — which is why the panel reports two counts
 *      rather than pretending one number covers both.
 *
 * Everything here is pure and allocation-conscious: it runs on every
 * keystroke against a list that can hold thousands of nodes. Traversal
 * is iterative with an explicit stack, matching every other walk in this
 * codebase.
 */
import type { HierarchyNode } from '@/types/hierarchy'
import type { AncestorRef, SearchHit } from '@/types/search'
import { scoreCandidates, type FieldSpec } from '@/utils/searchScoring'

import type { FindMode, FindScope } from './compileFind'


/**
 * How many prefilter survivors get scored.
 *
 * Ranking is O(fields x length) per candidate with a regex per character
 * in the word-boundary tier, so it is priced for hundreds of candidates,
 * not thousands. A query broad enough to survive this cap is a query the
 * user is about to narrow anyway, and the server tier is the one that
 * reports the true total.
 */
const RANK_BUDGET = 500

/** Rows handed to the panel per tier. Above this the list is noise, and
 *  `HitsByParent` virtualizes past 200 regardless. */
export const LOCAL_HIT_LIMIT = 200


/** One node, with every string it can be found by pre-lowercased.
 *  Built once per hydration, not once per keystroke. */
export interface LocalNodeDoc {
    node: HierarchyNode
    nameLc: string
    qnameLc: string
    /** name + qualified name + description + tags + entity type + every
     *  string-valued property key AND value, lowercased and joined. */
    haystackLc: string
}


/** Read a nested property bag off a node's data blob. The canvas
 *  convention is ``data.properties``; ``data.metadata`` is the legacy
 *  name still present on older nodes. */
function propertyBag(data: Record<string, unknown>): Record<string, unknown> | null {
    const props = data.properties ?? data.metadata
    return props && typeof props === 'object' ? props as Record<string, unknown> : null
}


function readString(v: unknown): string {
    return typeof v === 'string' ? v : ''
}


/**
 * Build the per-keystroke index.
 *
 * Memoize on ``displayFlat`` identity — it is itself memoized on the
 * layer assignment, so this rebuilds when the canvas hydrates, never
 * while the user types.
 */
export function buildLocalNodeIndex(
    flat: readonly HierarchyNode[],
): LocalNodeDoc[] {
    const docs: LocalNodeDoc[] = new Array(flat.length)
    for (let i = 0; i < flat.length; i++) {
        const node = flat[i]
        const data = node.data ?? {}
        const parts: string[] = [node.name, node.typeId]

        const qname = readString(data.qualifiedName)
        if (qname) parts.push(qname)
        const description = readString(data.description)
        if (description) parts.push(description)
        const businessLabel = readString(data.businessLabel)
        if (businessLabel) parts.push(businessLabel)
        if (node.tags) parts.push(...node.tags)

        // Property KEYS as well as values. The server's searchableText
        // carries values only, so "which tables even have a pii_class?"
        // is a question only the local tier can answer — and answering it
        // is strictly better than not.
        const props = propertyBag(data)
        if (props) {
            for (const [key, value] of Object.entries(props)) {
                parts.push(key)
                if (typeof value === 'string') parts.push(value)
                else if (typeof value === 'number' || typeof value === 'boolean') {
                    parts.push(String(value))
                }
            }
        }

        docs[i] = {
            node,
            nameLc: node.name.toLowerCase(),
            qnameLc: qname.toLowerCase(),
            haystackLc: parts.join(' ').toLowerCase(),
        }
    }
    return docs
}


/** Ranking weights. Name dominates; the wide haystack is a tiebreaker so
 *  a description hit never outranks a name hit. */
const RANK_FIELDS: FieldSpec<LocalNodeDoc>[] = [
    { get: (d) => d.node.name, weight: 1.0 },
    { get: (d) => d.qnameLc, weight: 0.5 },
    { get: (d) => d.node.tags ?? null, weight: 0.45 },
    { get: (d) => d.node.typeId, weight: 0.3 },
    { get: (d) => d.haystackLc, weight: 0.15 },
]


/** Does this doc match, under the scope and mode the user picked?
 *  Mirrors the operator the server would apply for the same controls. */
function isMatch(
    doc: LocalNodeDoc,
    q: string,
    mode: FindMode,
    scope: FindScope,
): boolean {
    const fields: string[] = scope === 'names'
        ? [doc.nameLc, doc.qnameLc]
        : scope === 'descriptions'
            ? [readString(doc.node.data?.description).toLowerCase()]
            : scope === 'tags'
                ? [(doc.node.tags ?? []).join(' ').toLowerCase()]
                : [doc.haystackLc]

    for (const f of fields) {
        if (!f) continue
        if (mode === 'contains' ? f.includes(q)
            : mode === 'startsWith' ? f.startsWith(q)
                : f === q) return true
    }
    return false
}


export interface LocalMatchResult {
    /** Ranked, capped at ``limit``. */
    hits: HierarchyNode[]
    /** Pre-cap count, so the panel can say "showing 200 of 1,340". */
    total: number
}


/**
 * Two stages on purpose: a cheap membership pass over every doc, then
 * ranking over at most ``RANK_BUDGET`` survivors. Ranking the whole list
 * would be the thing that makes typing stutter.
 */
export function matchLocalNodes(
    docs: readonly LocalNodeDoc[],
    text: string,
    mode: FindMode,
    scope: FindScope,
    limit: number = LOCAL_HIT_LIMIT,
): LocalMatchResult {
    const q = text.trim().toLowerCase()
    if (!q) return { hits: [], total: 0 }

    const survivors: LocalNodeDoc[] = []
    let total = 0
    for (let i = 0; i < docs.length; i++) {
        if (!isMatch(docs[i], q, mode, scope)) continue
        total++
        if (survivors.length < RANK_BUDGET) survivors.push(docs[i])
    }
    if (total === 0) return { hits: [], total: 0 }

    const ranked = scoreCandidates(survivors, q, RANK_FIELDS)
    // A survivor that scores zero still matched the prefilter — the hit
    // was in a field the ranker doesn't weigh (a property key, say). Keep
    // it, ordered behind everything that did score, rather than silently
    // dropping a real match.
    const scoredIds = new Set(ranked.map((r) => r.item.node.id))
    const hits: HierarchyNode[] = ranked.map((r) => r.item.node)
    for (const doc of survivors) {
        if (hits.length >= limit) break
        if (!scoredIds.has(doc.node.id)) hits.push(doc.node)
    }
    return { hits: hits.slice(0, limit), total }
}


/**
 * Root-to-parent ancestor chain for a locally-matched node.
 *
 * This is what makes a collapsed container say "3 matches inside" — the
 * store derives its roll-up counts from each hit's ancestor path, and a
 * hit with no path contributes to no badge. A local hit buried four
 * levels down inside a closed folder would otherwise be invisible, which
 * is the one thing a search over a collapsed tree must never be.
 *
 * Cycle-safe: a malformed parent chain terminates instead of hanging the
 * keystroke.
 */
export function ancestorPathFor(
    node: HierarchyNode,
    parentMap: ReadonlyMap<string, string>,
    displayMap: ReadonlyMap<string, HierarchyNode>,
): AncestorRef[] {
    const chain: AncestorRef[] = []
    const seen = new Set<string>([node.id])
    let currentId = node.parentId ?? parentMap.get(node.id)
    while (currentId && !seen.has(currentId)) {
        seen.add(currentId)
        const ancestor = displayMap.get(currentId)
        if (!ancestor) break
        chain.push({
            urn: ancestor.urn || ancestor.id,
            displayName: ancestor.name,
            entityType: ancestor.typeId,
        })
        currentId = ancestor.parentId ?? parentMap.get(currentId)
    }
    // Collected leaf-upward; the contract (and HitsByParent's "last
    // element is the immediate parent") is root-downward.
    return chain.reverse()
}


/**
 * Present a local match in the same shape a server hit arrives in, so
 * one list, one row renderer, and one reveal path serve both tiers.
 */
export function toSyntheticHit(
    node: HierarchyNode,
    ancestorPath: AncestorRef[],
): SearchHit {
    const data = node.data ?? {}
    const props = propertyBag(data)
    return {
        node: {
            urn: node.urn || node.id,
            entityType: node.typeId,
            displayName: node.name,
            ...(readString(data.qualifiedName)
                ? { qualifiedName: readString(data.qualifiedName) } : {}),
            ...(readString(data.description)
                ? { description: readString(data.description) } : {}),
            properties: props ?? {},
            ...(node.tags?.length ? { tags: node.tags } : {}),
        },
        ancestorPath,
    }
}
