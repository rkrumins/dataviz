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
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
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

// Per-context caches — keyed by workspaceId or connectionId (or '__primary__' when null)
const metadataCache = new Map<string, OntologyMetadata>()
const fetchPromises = new Map<string, Promise<OntologyMetadata>>()

function cacheKey(workspaceId: string | null, connectionId: string | null): string {
    return workspaceId ?? connectionId ?? '__primary__'
}

// Export cached metadata for external access (e.g. App.tsx)
export function getCachedOntologyMetadata(workspaceId?: string | null, connectionId?: string | null): OntologyMetadata | null {
    return metadataCache.get(cacheKey(workspaceId ?? null, connectionId ?? null)) ?? null
}

/**
 * Hook to access ontology metadata.
 * Fetches from the backend on first use per workspace/connection and caches.
 * All edge classification is ontology-driven — no hardcoded type checks.
 */
export function useOntologyMetadata(): UseOntologyMetadataResult {
    const { provider, workspaceId, connectionId } = useGraphProviderContext()
    const key = cacheKey(workspaceId, connectionId)

    const [metadata, setMetadata] = useState<OntologyMetadata | null>(metadataCache.get(key) ?? null)
    const [isLoading, setIsLoading] = useState(!metadataCache.has(key))
    const [error, setError] = useState<Error | null>(null)

    const fetchMetadata = useCallback(async () => {
        const existing = fetchPromises.get(key)
        if (existing) {
            try {
                const result = await existing
                setMetadata(result)
                setIsLoading(false)
            } catch (err) {
                setError(err as Error)
                setIsLoading(false)
            }
            return
        }

        if (metadataCache.has(key)) {
            setMetadata(metadataCache.get(key)!)
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        setError(null)

        const promise = provider.getOntologyMetadata()
        fetchPromises.set(key, promise)

        try {
            const result = await promise
            metadataCache.set(key, result)
            setMetadata(result)
            setIsLoading(false)
            fetchPromises.delete(key)
            console.log('[OntologyService] Loaded ontology metadata for', key, {
                containmentTypes: result.containmentEdgeTypes,
                lineageTypes: result.lineageEdgeTypes,
                edgeTypeCount: Object.keys(result.edgeTypeMetadata).length,
            })
        } catch (err) {
            console.error('[OntologyService] Failed to load ontology metadata:', err)
            setError(err as Error)
            setIsLoading(false)
            fetchPromises.delete(key)
            // Fallback metadata — only used when backend is unreachable
            const fallbackMetadata: OntologyMetadata = {
                containmentEdgeTypes: ['CONTAINS', 'BELONGS_TO', 'PRODUCES'],
                lineageEdgeTypes: ['TRANSFORMS', 'CONSUMES', 'RELATED_TO'],
                edgeTypeMetadata: {},
                entityTypeHierarchy: {},
                rootEntityTypes: [],
            }
            metadataCache.set(key, fallbackMetadata)
            setMetadata(fallbackMetadata)
        }
    }, [provider, key])

    // Re-fetch when connectionId changes
    useEffect(() => {
        fetchMetadata()
    }, [fetchMetadata])

    const refresh = useCallback(async () => {
        metadataCache.delete(key)
        fetchPromises.delete(key)
        await fetchMetadata()
    }, [key, fetchMetadata])

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

