import { useState, useCallback } from 'react'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useOntologyMetadata } from '@/services/ontologyService'

interface UseEntityLoaderResult {
    loadChildren: (parentId: string) => Promise<void>
    isLoading: boolean
    loadingNodes: Set<string>
}

/**
 * Generic hook to handle lazy loading of entity children
 * Checks if children are already loaded in the canvas store before fetching
 */
export function useEntityLoader(): UseEntityLoaderResult {
    const { nodes, edges, addNodes, addEdges } = useCanvasStore()
    const provider = useGraphProvider()
    const { containmentEdgeTypes } = useOntologyMetadata()
    const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())

    const loadChildren = useCallback(async (parentId: string) => {
        const parentNode = nodes.find(n => n.id === parentId)
        if (!parentNode) return

        // Prevent duplicate fetching
        if (loadingNodes.has(parentId)) return

        // 1. Check if we really need to load
        const nodeData = parentNode.data as any
        const childCount = (nodeData.childCount as number) || 0
        if (childCount === 0) return

        const existingNodeIds = new Set(nodes.map(n => n.id))

        // Count loaded children via containment edges
        // We use the ontology service's known containment types for robust matching
        const currentChildrenCount = edges.filter(e => {
            if (e.source !== parentId) return false
            if (!existingNodeIds.has(e.target)) return false // Edge must point to existing node

            const type = (e.data?.edgeType || e.data?.relationship || '').toUpperCase()
            // If we have ontology types, use them. Otherwise fallback to broad check.
            if (containmentEdgeTypes.length > 0) {
                return containmentEdgeTypes.some(t => t.toUpperCase() === type)
            }
            // Fallback for when ontology isn't loaded yet or valid
            return ['CONTAINS', 'HAS_CHILD', 'HAS_COLUMN', 'HAS_TABLE'].includes(type)
        }).length

        // If we have nearly all children (allow small drift), don't refetch
        if (currentChildrenCount >= childCount) return

        // 2. Fetch
        setLoadingNodes(prev => new Set(prev).add(parentId))
        try {
            const urn = (parentNode.data.urn as string) || parentId

            // Use specific types if available, otherwise provider defaults
            // This is safer than relying on hardcoded defaults
            const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined

            const children = await provider.getChildren(urn, {
                edgeTypes: fetchTypes,
                limit: 100 // Reasonable batch size
            })

            if (children.length > 0) {
                const nodesToAdd: LineageNode[] = []
                const edgesToAdd: LineageEdge[] = []
                const newIds = new Set<string>()

                children.forEach(child => {
                    // Check duplicates against store AND current batch
                    if (!existingNodeIds.has(child.urn) && !newIds.has(child.urn)) {
                        nodesToAdd.push({
                            id: child.urn,
                            type: 'generic',
                            position: { x: 0, y: 0 },
                            data: {
                                ...child,
                                label: child.displayName,
                                type: child.entityType, // Critical for rendering
                                urn: child.urn,
                                childCount: child.childCount,
                                metadata: child.properties,
                            }
                        } as any)
                        newIds.add(child.urn)
                    }

                    // Always ensure edge exists
                    const edgeId = `contains-${urn}-${child.urn}`
                    const edgeExists = edges.some(e => e.id === edgeId) || edgesToAdd.some(e => e.id === edgeId)

                    if (!edgeExists) {
                        edgesToAdd.push({
                            id: edgeId,
                            source: parentId, // Use the ID from the store
                            target: child.urn,
                            type: 'lineage',
                            data: {
                                edgeType: 'CONTAINS',
                                relationship: 'contains'
                            }
                        })
                    }
                })

                if (nodesToAdd.length > 0) addNodes(nodesToAdd)
                if (edgesToAdd.length > 0) addEdges(edgesToAdd)

                console.log(`[EntityLoader] Loaded ${nodesToAdd.length} children for ${parentId}`)
            }
        } catch (err) {
            console.error(`[EntityLoader] Failed to load children for ${parentId}`, err)
        } finally {
            setLoadingNodes(prev => {
                const next = new Set(prev)
                next.delete(parentId)
                return next
            })
        }
    }, [nodes, edges, provider, containmentEdgeTypes, addNodes, addEdges, loadingNodes])

    return {
        loadChildren,
        isLoading: loadingNodes.size > 0,
        loadingNodes
    }
}
