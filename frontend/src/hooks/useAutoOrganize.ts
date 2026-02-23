/**
 * useAutoOrganize
 *
 * Provides name-pattern grouping suggestions for the Layer Studio.
 * For each unassigned entity, checks if any existing logical node name
 * is a substring of the entity name/URN — and produces a suggested assignment.
 *
 * The user reviews suggestions before they are applied (non-destructive).
 */

import { useCallback, useState } from 'react'
import type { ViewLayerConfig, LogicalNodeConfig, EntityAssignmentConfig } from '@/types/schema'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GroupingSuggestion {
    entityId: string
    entityName: string
    entityType: string
    suggestedLayerId: string
    suggestedLayerName: string
    suggestedNodeId: string
    suggestedNodeName: string
    confidence: 'high' | 'medium' | 'low'
    reason: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FlatNode {
    layerId: string
    layerName: string
    nodeId: string
    nodeName: string
    depth: number
}

function flattenNodes(
    nodes: LogicalNodeConfig[],
    layerId: string,
    layerName: string,
    depth = 0
): FlatNode[] {
    return nodes.flatMap(n => [
        { layerId, layerName, nodeId: n.id, nodeName: n.name, depth },
        ...flattenNodes(n.children ?? [], layerId, layerName, depth + 1),
    ])
}

function normalise(s: string): string {
    return s.toLowerCase().replace(/[_\-. ]/g, '')
}

function scoreMatch(entityName: string, nodeName: string): number {
    const e = normalise(entityName)
    const n = normalise(nodeName)
    if (e === n) return 100
    if (e.includes(n) || n.includes(e)) return 75
    // Partial token match
    const tokens = n.split(/\s+/)
    const matchedTokens = tokens.filter(t => e.includes(t))
    return matchedTokens.length > 0 ? Math.round((matchedTokens.length / tokens.length) * 50) : 0
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseAutoOrganizeReturn {
    suggestions: GroupingSuggestion[]
    isAnalysing: boolean
    analyse: (
        entities: { id: string; name: string; type: string }[],
        layers: ViewLayerConfig[]
    ) => void
    acceptAll: (
        layers: ViewLayerConfig[],
        onUpdate: (layers: ViewLayerConfig[]) => void
    ) => void
    acceptOne: (
        suggestion: GroupingSuggestion,
        layers: ViewLayerConfig[],
        onUpdate: (layers: ViewLayerConfig[]) => void
    ) => void
    dismissOne: (entityId: string) => void
    clearAll: () => void
}

export function useAutoOrganize(): UseAutoOrganizeReturn {
    const [suggestions, setSuggestions] = useState<GroupingSuggestion[]>([])
    const [isAnalysing, setIsAnalysing] = useState(false)

    const analyse = useCallback(
        (
            entities: { id: string; name: string; type: string }[],
            layers: ViewLayerConfig[]
        ) => {
            setIsAnalysing(true)

            // All logical nodes across all layers, flattened
            const allNodes = layers.flatMap(l =>
                flattenNodes(l.logicalNodes ?? [], l.id, l.name)
            )

            if (allNodes.length === 0) {
                setSuggestions([])
                setIsAnalysing(false)
                return
            }

            // Assigned entity IDs (already have a logicalNodeId)
            const assignedIds = new Set(
                layers.flatMap(l =>
                    (l.entityAssignments ?? [])
                        .filter(a => a.logicalNodeId)
                        .map(a => a.entityId)
                )
            )

            const newSuggestions: GroupingSuggestion[] = []

            for (const entity of entities) {
                if (assignedIds.has(entity.id)) continue

                let bestScore = 0
                let bestNode: FlatNode | null = null

                for (const node of allNodes) {
                    const score = scoreMatch(entity.name, node.nodeName)
                    if (score > bestScore) {
                        bestScore = score
                        bestNode = node
                    }
                }

                // Only surface if score is meaningful
                if (bestScore >= 30 && bestNode) {
                    const confidence: GroupingSuggestion['confidence'] =
                        bestScore >= 75 ? 'high' : bestScore >= 50 ? 'medium' : 'low'

                    newSuggestions.push({
                        entityId: entity.id,
                        entityName: entity.name,
                        entityType: entity.type,
                        suggestedLayerId: bestNode.layerId,
                        suggestedLayerName: bestNode.layerName,
                        suggestedNodeId: bestNode.nodeId,
                        suggestedNodeName: bestNode.nodeName,
                        confidence,
                        reason: `"${entity.name}" matches group "${bestNode.nodeName}" (${bestScore}% confidence)`,
                    })
                }
            }

            // Sort: high confidence first
            newSuggestions.sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 }
                return order[a.confidence] - order[b.confidence]
            })

            setSuggestions(newSuggestions)
            setIsAnalysing(false)
        },
        []
    )

    const applyOneSuggestion = useCallback(
        (
            s: GroupingSuggestion,
            layers: ViewLayerConfig[],
            onUpdate: (layers: ViewLayerConfig[]) => void
        ) => {
            const next = layers.map(l => {
                if (l.id !== s.suggestedLayerId) {
                    // Remove from other layers if present
                    return {
                        ...l,
                        entityAssignments: (l.entityAssignments ?? []).filter(
                            a => a.entityId !== s.entityId
                        ),
                    }
                }

                // Remove old assignment, add new one with logicalNodeId
                const filtered = (l.entityAssignments ?? []).filter(
                    a => a.entityId !== s.entityId
                )
                const newAssignment: EntityAssignmentConfig = {
                    entityId: s.entityId,
                    layerId: s.suggestedLayerId,
                    logicalNodeId: s.suggestedNodeId,
                    inheritsChildren: true,
                    priority: 1000,
                    assignedBy: 'inference',
                    assignedAt: new Date().toISOString(),
                }
                return { ...l, entityAssignments: [...filtered, newAssignment] }
            })
            onUpdate(next)
        },
        []
    )

    const acceptAll = useCallback(
        (layers: ViewLayerConfig[], onUpdate: (layers: ViewLayerConfig[]) => void) => {
            let current = layers
            for (const s of suggestions) {
                let next = current.map(l => {
                    if (l.id !== s.suggestedLayerId) {
                        return {
                            ...l,
                            entityAssignments: (l.entityAssignments ?? []).filter(
                                a => a.entityId !== s.entityId
                            ),
                        }
                    }
                    const filtered = (l.entityAssignments ?? []).filter(a => a.entityId !== s.entityId)
                    return {
                        ...l,
                        entityAssignments: [
                            ...filtered,
                            {
                                entityId: s.entityId,
                                layerId: s.suggestedLayerId,
                                logicalNodeId: s.suggestedNodeId,
                                inheritsChildren: true,
                                priority: 1000,
                                assignedBy: 'inference' as const,
                                assignedAt: new Date().toISOString(),
                            },
                        ],
                    }
                })
                current = next
            }
            onUpdate(current)
            setSuggestions([])
        },
        [suggestions]
    )

    const acceptOne = useCallback(
        (
            suggestion: GroupingSuggestion,
            layers: ViewLayerConfig[],
            onUpdate: (layers: ViewLayerConfig[]) => void
        ) => {
            applyOneSuggestion(suggestion, layers, onUpdate)
            setSuggestions(prev => prev.filter(s => s.entityId !== suggestion.entityId))
        },
        [applyOneSuggestion]
    )

    const dismissOne = useCallback((entityId: string) => {
        setSuggestions(prev => prev.filter(s => s.entityId !== entityId))
    }, [])

    const clearAll = useCallback(() => setSuggestions([]), [])

    return {
        suggestions,
        isAnalysing,
        analyse,
        acceptAll,
        acceptOne,
        dismissOne,
        clearAll,
    }
}
