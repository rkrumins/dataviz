/**
 * Ontology Service - Fetches and caches ontology metadata from backend
 * 
 * This service provides a centralized way to access ontology metadata
 * including containment edge types, lineage edge types, and entity hierarchies.
 * All edge classification is derived from the backend ontology — no hardcoded types.
 * 
 * Designed as a universal abstraction layer for any graph backend
 * (FalkorDB, DataHub, OpenMetadata, etc.)
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { OntologyMetadata, EdgeTypeMetadata } from '@/providers/GraphDataProvider'

/** Edge classification categories derived from ontology */
export type EdgeClassification = 'structural' | 'flow' | 'metadata' | 'association'

interface UseOntologyMetadataResult {
    metadata: OntologyMetadata | null
    isLoading: boolean
    error: Error | null
    /** All edge types classified as containment by the ontology */
    containmentEdgeTypes: string[]
    /** All edge types classified as lineage/flow by the ontology */
    lineageEdgeTypes: string[]
    /** Check if an edge type is a containment edge */
    isContainmentEdge: (edgeType: string) => boolean
    /** Check if an edge type is a lineage/flow edge */
    isLineageEdge: (edgeType: string) => boolean
    /** Get the classification category of an edge type */
    getEdgeClassification: (edgeType: string) => EdgeClassification
    /** Get full metadata for an edge type */
    getEdgeTypeMetadata: (edgeType: string) => EdgeTypeMetadata | null
    refresh: () => Promise<void>
}

// Global cache to share metadata across components
let cachedMetadata: OntologyMetadata | null = null
let cachePromise: Promise<OntologyMetadata> | null = null

// Export cached metadata for external access (for App.tsx)
export function getCachedOntologyMetadata(): OntologyMetadata | null {
    return cachedMetadata
}

/**
 * Hook to access ontology metadata
 * Fetches from backend on first use and caches the result.
 * All edge classification is ontology-driven — no hardcoded type checks.
 */
export function useOntologyMetadata(): UseOntologyMetadataResult {
    const { provider } = useGraphProvider()
    const [metadata, setMetadata] = useState<OntologyMetadata | null>(cachedMetadata)
    const [isLoading, setIsLoading] = useState(!cachedMetadata)
    const [error, setError] = useState<Error | null>(null)

    const fetchMetadata = useCallback(async () => {
        if (cachePromise) {
            // If already fetching, wait for existing promise
            try {
                const result = await cachePromise
                setMetadata(result)
                setIsLoading(false)
                return
            } catch (err) {
                setError(err as Error)
                setIsLoading(false)
                return
            }
        }

        if (cachedMetadata) {
            // Use cached data
            setMetadata(cachedMetadata)
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            cachePromise = provider.getOntologyMetadata()
            const result = await cachePromise
            cachedMetadata = result
            setMetadata(result)
            setIsLoading(false)
            cachePromise = null
            console.log('[OntologyService] Loaded ontology metadata:', {
                containmentTypes: result.containmentEdgeTypes,
                lineageTypes: result.lineageEdgeTypes,
                edgeTypeCount: Object.keys(result.edgeTypeMetadata).length,
                entityTypeCount: Object.keys(result.entityTypeHierarchy).length
            })
        } catch (err) {
            console.error('[OntologyService] Failed to load ontology metadata:', err)
            setError(err as Error)
            setIsLoading(false)
            cachePromise = null
            // Set default fallback metadata — only used when backend is unreachable
            const fallbackMetadata: OntologyMetadata = {
                containmentEdgeTypes: ['CONTAINS', 'BELONGS_TO'],
                lineageEdgeTypes: ['TRANSFORMS', 'PRODUCES', 'CONSUMES', 'RELATED_TO'],
                edgeTypeMetadata: {},
                entityTypeHierarchy: {},
                rootEntityTypes: []
            }
            cachedMetadata = fallbackMetadata
            setMetadata(fallbackMetadata)
        }
    }, [provider])

    useEffect(() => {
        fetchMetadata()
    }, [fetchMetadata])

    const refresh = useCallback(async () => {
        cachedMetadata = null
        cachePromise = null
        await fetchMetadata()
    }, [fetchMetadata])

    // Memoize containmentEdgeTypes to prevent array recreation on every render
    const containmentEdgeTypesKey = metadata?.containmentEdgeTypes?.join(',') || ''
    const containmentEdgeTypes = useMemo(() => {
        const types = metadata?.containmentEdgeTypes || []
        return types.length > 0 ? [...types] : []
    }, [containmentEdgeTypesKey])

    // Memoize lineageEdgeTypes
    const lineageEdgeTypesKey = metadata?.lineageEdgeTypes?.join(',') || ''
    const lineageEdgeTypes = useMemo(() => {
        const types = metadata?.lineageEdgeTypes || []
        return types.length > 0 ? [...types] : []
    }, [lineageEdgeTypesKey])

    // Memoize isContainmentEdge — case-insensitive matching
    const isContainmentEdge = useCallback((edgeType: string): boolean => {
        if (!metadata || !containmentEdgeTypes.length) return false
        const normalizedEdgeType = edgeType.toUpperCase()
        return containmentEdgeTypes.some(type =>
            type.toUpperCase() === normalizedEdgeType
        )
    }, [metadata, containmentEdgeTypes])

    // isLineageEdge — case-insensitive matching against ontology lineage types
    const isLineageEdge = useCallback((edgeType: string): boolean => {
        if (!metadata || !lineageEdgeTypes.length) return false
        const normalizedEdgeType = edgeType.toUpperCase()
        return lineageEdgeTypes.some(type =>
            type.toUpperCase() === normalizedEdgeType
        )
    }, [metadata, lineageEdgeTypes])

    // getEdgeClassification — returns the ontology category for an edge type
    const getEdgeClassification = useCallback((edgeType: string): EdgeClassification => {
        if (!metadata?.edgeTypeMetadata) return 'association'
        // Try exact match first, then case-insensitive
        const meta = metadata.edgeTypeMetadata[edgeType]
            || metadata.edgeTypeMetadata[edgeType.toUpperCase()]
            || Object.entries(metadata.edgeTypeMetadata).find(
                ([key]) => key.toUpperCase() === edgeType.toUpperCase()
            )?.[1]
        return (meta?.category as EdgeClassification) || 'association'
    }, [metadata])

    // getEdgeTypeMetadata — returns full metadata for an edge type
    const getEdgeTypeMetadata = useCallback((edgeType: string): EdgeTypeMetadata | null => {
        if (!metadata?.edgeTypeMetadata) return null
        return metadata.edgeTypeMetadata[edgeType]
            || metadata.edgeTypeMetadata[edgeType.toUpperCase()]
            || Object.entries(metadata.edgeTypeMetadata).find(
                ([key]) => key.toUpperCase() === edgeType.toUpperCase()
            )?.[1]
            || null
    }, [metadata])

    return {
        metadata,
        isLoading,
        error,
        containmentEdgeTypes,
        lineageEdgeTypes,
        isContainmentEdge,
        isLineageEdge,
        getEdgeClassification,
        getEdgeTypeMetadata,
        refresh
    }
}

/**
 * Helper function to normalize edge type matching
 * Handles case-insensitive comparison and multiple field names
 */
export function normalizeEdgeType(edge: { data?: { edgeType?: string; relationship?: string } }): string {
    return (edge.data?.edgeType || edge.data?.relationship || '').toUpperCase()
}

/**
 * Helper function to check if an edge is a containment edge
 * Works with both edgeType and relationship fields
 */
export function isContainmentEdgeType(
    edgeType: string,
    containmentTypes: string[]
): boolean {
    const normalized = edgeType.toUpperCase()
    return containmentTypes.some(type => type.toUpperCase() === normalized)
}

/**
 * Helper function to check if an edge is a lineage/flow edge
 * Works with both edgeType and relationship fields
 */
export function isLineageEdgeType(
    edgeType: string,
    lineageTypes: string[]
): boolean {
    const normalized = edgeType.toUpperCase()
    return lineageTypes.some(type => type.toUpperCase() === normalized)
}

