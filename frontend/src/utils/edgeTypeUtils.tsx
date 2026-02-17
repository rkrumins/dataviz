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
import { normalizeEdgeType as normalizeEdgeTypeFromService } from '@/services/ontologyService'

// Re-export normalizeEdgeType for convenience
export { normalizeEdgeTypeFromService as normalizeEdgeType }
import {
    GitBranch,
    ArrowRight,
    Sparkles,
    Box,
    Layers,
    Workflow,
    Package,
    Database,
    Table2,
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
        const normalized = normalizeEdgeTypeFromService(edge)
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
 * Uses a hash-based color generation for consistency
 */
function getDefaultColor(type: string): string {
    // Color mapping for common types
    const colorMap: Record<string, string> = {
        'PRODUCES': '#22c55e',      // green-500
        'CONSUMES': '#3b82f6',      // blue-500
        'TRANSFORMS': '#f59e0b',    // amber-500
        'CONTAINS': '#8b5cf6',      // purple-500
        'BELONGS_TO': '#94a3b8',    // slate-400
        'DERIVES_FROM': '#a855f7',  // purple-400
        'LINEAGE': '#06b6d4',       // cyan-500
        'AGGREGATED': '#f59e0b',    // amber-500
        'TAGGED_WITH': '#6366f1',   // indigo-500
        'RELATED_TO': '#6b7280',    // gray-500
    }

    const normalized = type.toUpperCase()
    if (colorMap[normalized]) {
        return colorMap[normalized]
    }

    // Generate a consistent color from the type string
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
        hash = normalized.charCodeAt(i) + ((hash << 5) - hash)
    }

    // Generate a color in the blue-purple range
    const hue = Math.abs(hash % 360)
    return `hsl(${hue}, 65%, 50%)`
}

/**
 * Get default icon for edge type
 */
function getDefaultIcon(type: string): React.ReactNode {
    const normalized = type.toUpperCase()

    const iconMap: Record<string, React.ReactNode> = {
        'PRODUCES': <ArrowRight className="w-3.5 h-3.5" />,
        'CONSUMES': <ArrowRight className="w-3.5 h-3.5 rotate-180" />,
        'TRANSFORMS': <Sparkles className="w-3.5 h-3.5" />,
        'CONTAINS': <Box className="w-3.5 h-3.5" />,
        'BELONGS_TO': <Box className="w-3.5 h-3.5" />,
        'DERIVES_FROM': <GitBranch className="w-3.5 h-3.5" />,
        'LINEAGE': <GitBranch className="w-3.5 h-3.5" />,
        'AGGREGATED': <Layers className="w-3.5 h-3.5" />,
        'TAGGED_WITH': <Workflow className="w-3.5 h-3.5" />,
        'RELATED_TO': <GitBranch className="w-3.5 h-3.5" />,
    }

    return iconMap[normalized] || <GitBranch className="w-3.5 h-3.5" />
}

/**
 * Determine if edge type should be animated by default
 */
function getDefaultAnimated(type: string, isContainment: boolean): boolean {
    // Containment edges are typically not animated
    if (isContainment) return false

    // Lineage edges are typically animated
    const lineageTypes = ['PRODUCES', 'CONSUMES', 'TRANSFORMS', 'DERIVES_FROM', 'LINEAGE']
    return lineageTypes.includes(type.toUpperCase())
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
    const isContainment = containmentEdgeTypes.some(ct => ct.toUpperCase() === normalized)

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
    return normalizeEdgeTypeFromService({ data: { edgeType } }).toLowerCase()
}

