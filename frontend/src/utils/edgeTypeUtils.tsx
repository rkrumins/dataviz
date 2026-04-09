/**
 * Edge Type Utilities - Schema-driven edge type discovery and definition
 * 
 * Provides functions to:
 * - Discover unique edge types from canvas edges
 * - Get edge type definitions from schema (RelationshipTypeSchema)
 * - Create default definitions when schema doesn't have a type
 * - Normalize edge types for consistent matching
 */

import type { LineageEdge } from '@/store/canvas'
import type { RelationshipTypeSchema } from '@/types/schema'
import { normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'
import { generateColorFromType } from '@/lib/type-visuals'

export { normalizeEdgeType }
import {
    GitBranch,
} from 'lucide-react'
import React from 'react'

export interface EdgeTypeDefinition {
    type: string
    label: string
    description: string
    color: string
    strokeStyle: 'solid' | 'dashed' | 'dotted'
    animated: boolean
    icon: React.ReactNode
}

/**
 * Discover unique edge types from canvas edges
 * Returns a Set of normalized (uppercase) edge type strings
 */
export function discoverEdgeTypes(edges: LineageEdge[]): Set<string> {
    const types = new Set<string>()
    edges.forEach(edge => {
        const normalized = normalizeEdgeType(edge)
        if (normalized) {
            types.add(normalized)
        }
    })
    return types
}

/**
 * Get edge type definition from schema
 * Returns the RelationshipTypeSchema if found, null otherwise
 */
export function getEdgeTypeFromSchema(
    edgeType: string,
    relationshipTypes: RelationshipTypeSchema[]
): RelationshipTypeSchema | null {
    // Case-insensitive matching
    const normalized = edgeType.toUpperCase()
    return relationshipTypes.find(rt => rt.id.toUpperCase() === normalized) || null
}

/**
 * Format edge type ID to display label
 * Converts "PRODUCES" -> "Produces", "CONTAINS" -> "Contains", etc.
 */
function formatEdgeTypeLabel(type: string): string {
    // Handle snake_case and SCREAMING_SNAKE_CASE
    return type
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

/**
 * Get default color for edge type
 * Uses a hash-based color generation for consistency.
 * Schema-provided colors are preferred (handled by callers via getEdgeTypeDefinition).
 * This function is only called when the schema has no definition for the type.
 */
function getDefaultColor(type: string): string {
    return generateColorFromType(type.toUpperCase())
}

/**
 * Get default icon for edge type.
 * Schema-provided icons are preferred (handled by callers via getEdgeTypeDefinition).
 * This function is only called when the schema has no definition for the type,
 * so it returns a single generic icon rather than type-specific hardcoded maps.
 */
function getDefaultIcon(_type: string): React.ReactNode {
    return <GitBranch className="w-3.5 h-3.5" />
}

/**
 * Determine if edge type should be animated by default
 */
function getDefaultAnimated(_type: string, isContainment: boolean): boolean {
    // Containment edges are typically not animated
    if (isContainment) return false

    // Non-containment edges are animated by default (lineage/flow edges).
    // The schema definition overrides this when available.
    return true
}

/**
 * Determine default stroke style
 */
function getDefaultStrokeStyle(type: string, isContainment: boolean): 'solid' | 'dashed' | 'dotted' {
    // Containment edges are typically dashed
    if (isContainment) return 'dashed'

    // Aggregated edges are dashed
    if (type.toUpperCase() === 'AGGREGATED') return 'dashed'

    // Most lineage edges are solid
    return 'solid'
}

/**
 * Create default edge type definition when schema doesn't have it
 */
export function createDefaultEdgeTypeDefinition(
    edgeType: string,
    containmentEdgeTypes: string[],
    ontologyMetadata?: { edgeTypeMetadata?: Record<string, { description?: string }> }
): EdgeTypeDefinition {
    const normalized = edgeType.toUpperCase()
    const isContainment = isContainmentEdgeType(normalized, containmentEdgeTypes)

    // Try to get description from ontology metadata
    let description = `Edge type: ${formatEdgeTypeLabel(edgeType)}`
    if (ontologyMetadata?.edgeTypeMetadata?.[normalized]?.description) {
        description = ontologyMetadata.edgeTypeMetadata[normalized].description!
    } else if (isContainment) {
        description = 'Parent-child containment relationship'
    } else {
        description = `Data flow relationship: ${formatEdgeTypeLabel(edgeType)}`
    }

    return {
        type: normalized,
        label: formatEdgeTypeLabel(edgeType),
        description,
        color: getDefaultColor(edgeType),
        strokeStyle: getDefaultStrokeStyle(edgeType, isContainment),
        animated: getDefaultAnimated(edgeType, isContainment),
        icon: getDefaultIcon(edgeType),
    }
}

/**
 * Get edge type definition from schema or create default
 * This is the main function to use for getting edge type definitions
 */
export function getEdgeTypeDefinition(
    edgeType: string,
    relationshipTypes: RelationshipTypeSchema[],
    containmentEdgeTypes: string[],
    ontologyMetadata?: { edgeTypeMetadata?: Record<string, { description?: string }> }
): EdgeTypeDefinition {
    const schemaType = getEdgeTypeFromSchema(edgeType, relationshipTypes)

    if (schemaType) {
        // Use schema definition
        return {
            type: schemaType.id.toUpperCase(),
            label: schemaType.name,
            description: schemaType.description || `Edge type: ${schemaType.name}`,
            color: schemaType.visual.strokeColor,
            strokeStyle: schemaType.visual.strokeStyle,
            animated: schemaType.visual.animated,
            icon: getDefaultIcon(schemaType.id), // Could be enhanced to use schema icon if available
        }
    }

    // Create default definition
    return createDefaultEdgeTypeDefinition(edgeType, containmentEdgeTypes, ontologyMetadata)
}

/**
 * Get all edge type definitions for edges in the canvas
 * Returns an array of EdgeTypeDefinition sorted by label
 */
export function getAllEdgeTypeDefinitions(
    edges: LineageEdge[],
    relationshipTypes: RelationshipTypeSchema[],
    containmentEdgeTypes: string[],
    ontologyMetadata?: { edgeTypeMetadata?: Record<string, { description?: string }> }
): EdgeTypeDefinition[] {
    const discoveredTypes = discoverEdgeTypes(edges)
    const definitions = Array.from(discoveredTypes).map(type =>
        getEdgeTypeDefinition(type, relationshipTypes, containmentEdgeTypes, ontologyMetadata)
    )

    // Sort by label for consistent display
    return definitions.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Normalize edge type for UI matching (case-insensitive)
 * Converts to lowercase for matching against filter/legend types
 */
export function normalizeEdgeTypeForMatching(edgeType: string): string {
    return normalizeEdgeType({ data: { edgeType } }).toLowerCase()
}

