/**
 * Ontology Service - Fetches and caches ontology metadata from backend
 * 
 * This service provides a centralized way to access ontology metadata
 * including containment edge types and entity hierarchies. It caches
 * the metadata to avoid repeated API calls.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { OntologyMetadata } from '@/providers/GraphDataProvider'

interface UseOntologyMetadataResult {
    metadata: OntologyMetadata | null
    isLoading: boolean
    error: Error | null
    containmentEdgeTypes: string[]
    isContainmentEdge: (edgeType: string) => boolean
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
 * Fetches from backend on first use and caches the result
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
                edgeTypeCount: Object.keys(result.edgeTypeMetadata).length,
                entityTypeCount: Object.keys(result.entityTypeHierarchy).length
            })
        } catch (err) {
            console.error('[OntologyService] Failed to load ontology metadata:', err)
            setError(err as Error)
            setIsLoading(false)
            cachePromise = null
            // Set default fallback metadata
            const fallbackMetadata: OntologyMetadata = {
                containmentEdgeTypes: ['CONTAINS', 'BELONGS_TO'],
                edgeTypeMetadata: {},
                entityTypeHierarchy: {}
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
    // Use join to create a stable string key for comparison
    const containmentEdgeTypesKey = metadata?.containmentEdgeTypes?.join(',') || ''
    const containmentEdgeTypes = useMemo(() => {
        const types = metadata?.containmentEdgeTypes || []
        return types.length > 0 ? [...types] : []
    }, [containmentEdgeTypesKey])
    
    // Memoize isContainmentEdge to prevent function recreation
    const isContainmentEdge = useCallback((edgeType: string): boolean => {
        if (!metadata || !containmentEdgeTypes.length) return false
        
        // Case-insensitive matching
        const normalizedEdgeType = edgeType.toUpperCase()
        return containmentEdgeTypes.some(type => 
            type.toUpperCase() === normalizedEdgeType
        )
    }, [metadata, containmentEdgeTypes])

    return {
        metadata,
        isLoading,
        error,
        containmentEdgeTypes,
        isContainmentEdge,
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

