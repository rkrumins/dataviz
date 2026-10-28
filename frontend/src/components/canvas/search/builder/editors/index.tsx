/**
 * What an edge filter's editor may consume: the discovered property keys,
 * tags, edge types and value samples behind its autocomplete
 * (``EdgePredicateEditor``; ``useEdgeEditorContext`` builds one).
 */


export interface EditorContext {
    /** Native property keys present per entity-type label (from /search/discover).
     *  Empty object before the first discovery response settles. */
    keysByEntityType: Record<string, string[]>
    /** Union of all native property keys across labels. */
    allKeys: string[]
    /** Entity types known to the active view. */
    knownEntityTypes: string[]
    /** Layers configured in the active view (if available). */
    knownLayers: string[]
    /** Tag values surfaced by /search/discover, ordered by descending
     *  count. */
    tagValues: string[]
    /** Look up sample values for a property key. Returns ``[]`` when
     *  discovery hasn't surfaced any. */
    getValueSamples: (propertyKey: string) => unknown[]
    /** Edge types present in the sample. */
    edgeTypes: string[]
    /** Property keys per edge type. */
    keysByEdgeType: Record<string, string[]>
    /** Look up sample values for an edge property key. */
    getEdgeValueSamples: (edgeType: string, propertyKey: string) => unknown[]
    /** Where each edge key is kept (``useDiscovery``); one kept in the
     *  edge's JSON of user properties takes presence and equality only. */
    edgeKeyStoredAs?: Record<string, 'native' | 'json'>
}
