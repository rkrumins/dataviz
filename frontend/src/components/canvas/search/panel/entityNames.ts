/**
 * entityNames — finding entities by name, and naming one back by the
 * shortest path of names that names it alone. Shared by the name picker
 * (`NodeRefPicker`) and the query editor's `@"…"` completion, so both
 * offer the same entities and write the same paths.
 */
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { AncestorRef, NodeRef } from '@/types/search'

import { pathCandidates } from './relations'


/** An entity as a name search finds it: name, type, and its containers'
 *  names, top first. */
export interface NamedEntity {
    urn: string
    name: string
    type: string
    ancestors: string[]
}

/** Suggestions offered for a typed name. */
export const NAME_SUGGESTIONS = 8


export function namedEntityOf(e: { urn: string; displayName?: string | null; entityType?: string | null;
                                   ancestorPath?: AncestorRef[] | null }): NamedEntity {
    return {
        urn: e.urn, name: e.displayName || e.urn, type: e.entityType ?? '',
        ancestors: (e.ancestorPath ?? []).map((a) => a.displayName),
    }
}


/** The view's entities whose name holds ``word`` — a server search, so it
 *  stays quick however large the view. */
export async function searchEntitiesByName(
    remote: RemoteGraphProvider, viewId: string, word: string,
    { signal }: { signal?: AbortSignal } = {},
): Promise<NamedEntity[]> {
    const page = await remote.searchAdvanced({
        predicate: { kind: 'group', op: 'and', children: [
            { kind: 'text', value: word, target: 'name', match: 'substring' }] },
        scope: { viewId, scopeMode: 'view' },
        options: { results: 'hits', pageSize: NAME_SUGGESTIONS, includeAncestorPath: true,
                   highlights: false, waitMs: 800 },
    }, { signal })
    return (page.hits ?? []).map((h) => namedEntityOf({ ...h.node, ancestorPath: h.ancestorPath }))
}


/** The shortest path of names that names ``entity`` alone in the view —
 *  every candidate checked in one request — or its URN when none does. */
export async function namePathFor(remote: RemoteGraphProvider, viewId: string,
                                  entity: NamedEntity): Promise<NodeRef> {
    const candidates = pathCandidates(entity.name, entity.ancestors)
    if (!candidates.length) return { urn: entity.urn }
    try {
        const { results } = await remote.resolveSearchRefs(
            { scope: { viewId }, refs: candidates.map((path) => ({ path })) })
        const i = results.findIndex((r) => r.count === 1 && r.matches?.[0]?.urn === entity.urn)
        return i >= 0 ? { path: candidates[i] } : { urn: entity.urn }
    } catch {
        return { urn: entity.urn }
    }
}
