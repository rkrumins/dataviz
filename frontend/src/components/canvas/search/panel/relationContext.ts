/**
 * relationContext — what a condition row can't know on its own: how deep in
 * relationships it sits (the server allows three), whether it is a display
 * rule's (a rule follows lineage one hop and has no routes), the view a
 * name path is resolved in, and the discovered edge keys an edge filter
 * offers. ``RelationProvider`` (RelationshipEditor.tsx) sets it for a
 * builder; each relationship's nested builder sits one deeper.
 */
import { createContext, useContext, useMemo } from 'react'

import type { EditorContext } from '../builder/editors'
import type { ValueSuggester } from '../builder/useDiscovery'

import type { LayerOption } from './layerOptions'


export interface RelationContextValue {
    /** Relationships this row sits inside (0: the query's own row). */
    depth: number
    /** Whether a row of the query's own sits in its top-level AND (unset: it
     *  does) — "any of" and "not" take that away, as the server reads it. */
    top?: boolean
    /** A display rule's: lineage goes one hop. */
    rule: boolean
    /** The view a name path is resolved in (the name picker's badge). */
    viewId?: string | null
    edges?: Pick<EditorContext, 'edgeTypes' | 'keysByEdgeType' | 'getEdgeValueSamples' | 'edgeKeyStoredAs'>
}

export const RelationContext = createContext<RelationContextValue>({ depth: 0, rule: false })


/** The node discovery a builder is handed. */
export interface RelationDiscovery {
    allKeys: string[]
    keysByEntityType: Record<string, string[]>
    tagValues: string[]
    getValueSamples: (key: string) => unknown[]
    suggestValues?: ValueSuggester
}


/** What the edge-filter editor offers: the discovered edge keys, and the
 *  node discovery it falls back on. */
export function useEdgeEditorContext(
    discovery: RelationDiscovery,
    knownEntityTypes: string[],
    discoveredLayers: LayerOption[],
): EditorContext {
    const { edges } = useContext(RelationContext)
    return useMemo<EditorContext>(() => ({
        keysByEntityType: discovery.keysByEntityType,
        allKeys: discovery.allKeys,
        knownEntityTypes,
        knownLayers: discoveredLayers.map((l) => l.label),
        tagValues: discovery.tagValues,
        getValueSamples: discovery.getValueSamples,
        edgeTypes: edges?.edgeTypes ?? [],
        keysByEdgeType: edges?.keysByEdgeType ?? {},
        getEdgeValueSamples: edges?.getEdgeValueSamples ?? (() => []),
        edgeKeyStoredAs: edges?.edgeKeyStoredAs,
    }), [discovery, knownEntityTypes, discoveredLayers, edges])
}
