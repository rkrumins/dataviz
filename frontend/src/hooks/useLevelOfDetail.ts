/**
 * @deprecated Use useSemanticZoom instead — ontology-driven thresholds, event-based (no polling).
 *
 * useLevelOfDetail Hook
 *
 * Automatically adjusts graph granularity based on zoom level.
 * Provides smooth LOD transitions for optimal performance at different zoom levels.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useLineageExplorationStore } from './useLineageExploration'
import { usePreferencesStore } from '@/store/preferences'
import type { LineageGranularity } from '@/types/schema'

// LOD thresholds - zoom levels at which granularity changes
export interface LODThreshold {
    minZoom: number
    maxZoom: number
    granularity: LineageGranularity
    label: string
}

export const DEFAULT_LOD_THRESHOLDS: LODThreshold[] = [
    { minZoom: 0, maxZoom: 0.3, granularity: 'domain', label: 'Domain Overview' },
    { minZoom: 0.3, maxZoom: 0.5, granularity: 'system', label: 'System View' },
    { minZoom: 0.5, maxZoom: 0.8, granularity: 'schema', label: 'Schema View' },
    { minZoom: 0.8, maxZoom: 1.5, granularity: 'table', label: 'Table View' },
    { minZoom: 1.5, maxZoom: Infinity, granularity: 'column', label: 'Column Detail' },
]

export interface LODState {
    currentZoom: number
    currentGranularity: LineageGranularity
    currentLabel: string
    isAutoLOD: boolean
    thresholds: LODThreshold[]
}

export interface UseLevelOfDetailResult {
    state: LODState
    enableAutoLOD: () => void
    disableAutoLOD: () => void
    toggleAutoLOD: () => void
    getGranularityForZoom: (zoom: number) => LineageGranularity
    getLabelForZoom: (zoom: number) => string
}

export function useLevelOfDetail(): UseLevelOfDetailResult {
    const { getZoom } = useReactFlow()
    const setGranularity = useLineageExplorationStore((s) => s.setGranularity)
    const currentGranularity = useLineageExplorationStore((s) => s.config.granularity)

    // Store auto-LOD preference
    const isAutoLOD = usePreferencesStore((s) => s.autoLOD ?? false)
    const setAutoLOD = usePreferencesStore((s) => s.setAutoLOD)

    const lastGranularityRef = useRef<LineageGranularity>(currentGranularity)
    const zoomRef = useRef<number>(1)

    // Get granularity for a given zoom level
    const getGranularityForZoom = useCallback((zoom: number): LineageGranularity => {
        const threshold = DEFAULT_LOD_THRESHOLDS.find(
            (t) => zoom >= t.minZoom && zoom < t.maxZoom
        )
        return threshold?.granularity ?? 'table'
    }, [])

    // Get label for a given zoom level
    const getLabelForZoom = useCallback((zoom: number): string => {
        const threshold = DEFAULT_LOD_THRESHOLDS.find(
            (t) => zoom >= t.minZoom && zoom < t.maxZoom
        )
        return threshold?.label ?? 'Table View'
    }, [])

    // Compute current state
    const state = useMemo((): LODState => {
        const zoom = zoomRef.current
        return {
            currentZoom: zoom,
            currentGranularity,
            currentLabel: getLabelForZoom(zoom),
            isAutoLOD,
            thresholds: DEFAULT_LOD_THRESHOLDS,
        }
    }, [currentGranularity, isAutoLOD, getLabelForZoom])

    // Enable/disable auto-LOD
    const enableAutoLOD = useCallback(() => {
        setAutoLOD?.(true)
    }, [setAutoLOD])

    const disableAutoLOD = useCallback(() => {
        setAutoLOD?.(false)
    }, [setAutoLOD])

    const toggleAutoLOD = useCallback(() => {
        setAutoLOD?.(!isAutoLOD)
    }, [isAutoLOD, setAutoLOD])

    // Effect to update granularity on zoom change (when auto-LOD is enabled)
    useEffect(() => {
        if (!isAutoLOD) return

        // Poll zoom level (React Flow doesn't provide a zoom change event)
        const interval = setInterval(() => {
            try {
                const zoom = getZoom()
                zoomRef.current = zoom

                const targetGranularity = getGranularityForZoom(zoom)

                // Only update if granularity actually changed
                if (targetGranularity !== lastGranularityRef.current) {
                    lastGranularityRef.current = targetGranularity
                    setGranularity(targetGranularity)
                }
            } catch {
                // React Flow not ready yet
            }
        }, 200) // Check every 200ms

        return () => clearInterval(interval)
    }, [isAutoLOD, getZoom, getGranularityForZoom, setGranularity])

    return {
        state,
        enableAutoLOD,
        disableAutoLOD,
        toggleAutoLOD,
        getGranularityForZoom,
        getLabelForZoom,
    }
}

/**
 * Simple hook for components that just need zoom tracking
 */
export function useZoomLevel(): number {
    const { getZoom } = useReactFlow()
    const zoomRef = useRef<number>(1)

    useEffect(() => {
        const interval = setInterval(() => {
            try {
                zoomRef.current = getZoom()
            } catch {
                // React Flow not ready
            }
        }, 100)

        return () => clearInterval(interval)
    }, [getZoom])

    return zoomRef.current
}
