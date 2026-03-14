import { useState, useCallback } from 'react'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useOntologyMetadata } from '@/services/ontologyService'

interface UseEntityLoaderResult {
    loadChildren: (parentId: string) => Promise<void>
    searchChildren: (parentId: string, query: string) => Promise<void>
    isLoading: boolean
    loadingNodes: Set<string>
    failedNodes: Set<string>
}

/**
 * Generic hook to handle lazy loading of entity children
 * Checks if children are already loaded in the canvas store before fetching
 */
export function useEntityLoader(): UseEntityLoaderResult {
    const { nodes, edges, addNodes, addEdges, removeNodes, removeEdges } = useCanvasStore()
    const provider = useGraphProvider()
    const { containmentEdgeTypes } = useOntologyMetadata()
    const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())
    const [failedNodes, setFailedNodes] = useState<Set<string>>(new Set())

    const loadChildren = useCallback(async (parentId: string) => {
        // Handle root loading (empty parentId)
        if (!parentId) {
            if (loadingNodes.has('ROOT')) return
            setLoadingNodes(prev => new Set(prev).add('ROOT'))
            try {
                // Fetch root entities as defined in ontology or provider defaults
                const roots = await provider.getNodes({
                    entityTypes: containmentEdgeTypes.length > 0 ? undefined : ['domain', 'system'],
                    limit: 50
                })

                if (roots.length > 0) {
                    const nodesToAdd: LineageNode[] = roots.map(root => ({
                        id: root.urn,
                        type: 'generic',
                        position: { x: 0, y: 0 },
                        data: {
                            ...root,
                            label: root.displayName,
                            type: root.entityType,
                            urn: root.urn,
                            childCount: root.childCount,
                            metadata: root.properties,
                            classifications: root.tags,
                        }
                    } as any))
                    addNodes(nodesToAdd)
                }
            } catch (err) {
                console.error('[EntityLoader] Failed to load roots', err)
            } finally {
                setLoadingNodes(prev => {
                    const next = new Set(prev)
                    next.delete('ROOT')
                    return next
                })
            }
            return
        }

        const parentNode = nodes.find(n => n.id === parentId)
        if (!parentNode) return

        // Prevent duplicate fetching
        if (loadingNodes.has(parentId)) return

        // 1. Check if we really need to load
        const nodeData = parentNode.data as any
        // Check for childCount in data root OR metadata (handle different loading sources)
        const childCount = (nodeData.childCount as number) ?? (nodeData.metadata?.childCount as number) ?? 0

        // Debug logging to help trace issues
        // console.log(`[EntityLoader] Checking ${parentId}: childCount=${childCount}, loaded=${currentChildrenCount}`)

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
        if (currentChildrenCount >= childCount && childCount > 0) return

        // 2. Fetch — clear any prior failure for this node on retry
        setFailedNodes(prev => { const next = new Set(prev); next.delete(parentId); return next })
        setLoadingNodes(prev => new Set(prev).add(parentId))
        try {
            const urn = (parentNode.data.urn as string) || parentId

            // Use specific types if available, otherwise provider defaults
            // This is safer than relying on hardcoded defaults
            const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined

            // Smart Pagination Request: Load up to 20 per request, offsetting by already loaded
            const children = await provider.getChildren(urn, {
                edgeTypes: fetchTypes,
                limit: 20,
                offset: currentChildrenCount
            })

            if (children.length > 0) {
                const freshNodes = useCanvasStore.getState().nodes
                const freshEdges = useCanvasStore.getState().edges
                const currentExistingNodeIds = new Set(freshNodes.map(n => n.id))

                const nodesToAdd: LineageNode[] = []
                const edgesToAdd: LineageEdge[] = []
                const newIds = new Set<string>()

                children.forEach(child => {
                    // Check duplicates against store AND current batch
                    if (!currentExistingNodeIds.has(child.urn) && !newIds.has(child.urn)) {
                        nodesToAdd.push({
                            id: child.urn,
                            type: 'generic',
                            position: { x: 0, y: 0 },
                            data: {
                                ...child,
                                label: child.displayName,
                                type: child.entityType === 'schemaField' ? 'column' : child.entityType, // Critical for rendering
                                urn: child.urn,
                                childCount: child.childCount,
                                metadata: child.properties,
                                // Correctly map tags to classifications for hierarchy view
                                classifications: child.tags,
                                businessLabel: child.properties?.businessLabel,
                            }
                        } as any)
                        newIds.add(child.urn)
                    }

                    // Always ensure edge exists
                    const edgeId = `contains-${urn}-${child.urn}`
                    const edgeExists = freshEdges.some(e => e.id === edgeId) || edgesToAdd.some(e => e.id === edgeId)

                    if (!edgeExists) {
                        // Use ontology-defined containment type if available, else CONTAINS
                        const relationType = containmentEdgeTypes.length > 0 ? containmentEdgeTypes[0] : 'CONTAINS'

                        edgesToAdd.push({
                            id: edgeId,
                            source: parentId, // Use the ID from the store
                            target: child.urn,
                            type: 'lineage',
                            data: {
                                edgeType: relationType,
                                relationship: relationType.toLowerCase()
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
            setFailedNodes(prev => new Set(prev).add(parentId))
        } finally {
            setLoadingNodes(prev => {
                const next = new Set(prev)
                next.delete(parentId)
                return next
            })
        }
    }, [nodes, edges, provider, containmentEdgeTypes, addNodes, addEdges, loadingNodes])

    const searchChildren = useCallback(async (parentId: string, query: string) => {
        if (!query.trim()) return

        setLoadingNodes(prev => new Set(prev).add(parentId))
        try {
            const parentNode = nodes.find(n => n.id === parentId)
            const urn = parentNode ? (parentNode.data.urn as string || parentId) : parentId

            const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined

            // Server-side search
            const children = await provider.getChildren(urn, {
                edgeTypes: fetchTypes,
                searchQuery: query,
                limit: 50
            })

            // Always get the freshest state right before mutating
            const freshNodes = useCanvasStore.getState().nodes
            const freshEdges = useCanvasStore.getState().edges

            if (children.length >= 0) {
                // First, clean up the exact current children of this node to replace them with search results
                const existingEdgesToRemove = freshEdges.filter(e => e.source === parentId)
                const targetNodeIdsToRemove = new Set(existingEdgesToRemove.map(e => e.target))

                // Keep nodes that might be connected to other parents
                const otherEdges = freshEdges.filter(e => e.source !== parentId)
                const safeNodesToKeep = new Set(otherEdges.map(e => e.target))
                const nodeIdsToRemove = Array.from(targetNodeIdsToRemove).filter(id => !safeNodesToKeep.has(id))
                const edgeIdsToRemove = existingEdgesToRemove.map(e => e.id)

                // Purge them from the canvas view immediately
                if (nodeIdsToRemove.length > 0) removeNodes(nodeIdsToRemove)
                if (edgeIdsToRemove.length > 0) removeEdges(edgeIdsToRemove)

                if (children.length > 0) {
                    const nodesToAdd: LineageNode[] = []
                    const edgesToAdd: LineageEdge[] = []

                    // Re-calculate existing state post-removal
                    const remainingNodeIds = new Set(freshNodes.map(n => n.id))
                    nodeIdsToRemove.forEach(id => remainingNodeIds.delete(id))

                    const remainingEdges = freshEdges.filter(e => !edgeIdsToRemove.includes(e.id))
                    const newIds = new Set<string>()

                    children.forEach(child => {
                        if (!remainingNodeIds.has(child.urn) && !newIds.has(child.urn)) {
                            nodesToAdd.push({
                                id: child.urn,
                                type: 'generic',
                                position: { x: 0, y: 0 },
                                data: {
                                    ...child,
                                    label: child.displayName,
                                    type: child.entityType === 'schemaField' ? 'column' : child.entityType,
                                    urn: child.urn,
                                    childCount: child.childCount,
                                    metadata: child.properties,
                                    classifications: child.tags,
                                    businessLabel: child.properties?.businessLabel,
                                }
                            } as any)
                            newIds.add(child.urn)
                        }

                        const edgeId = `contains-${urn}-${child.urn}`
                        const edgeExists = remainingEdges.some(e => e.id === edgeId) || edgesToAdd.some(e => e.id === edgeId)

                        if (!edgeExists) {
                            const relationType = containmentEdgeTypes.length > 0 ? containmentEdgeTypes[0] : 'CONTAINS'
                            edgesToAdd.push({
                                id: edgeId,
                                source: parentId,
                                target: child.urn,
                                type: 'lineage',
                                data: {
                                    edgeType: relationType,
                                    relationship: relationType.toLowerCase()
                                }
                            })
                        }
                    })

                    if (nodesToAdd.length > 0) addNodes(nodesToAdd)
                    if (edgesToAdd.length > 0) addEdges(edgesToAdd)
                }
            }
        } catch (err) {
            console.error(`[EntityLoader] Failed to search children for ${parentId}`, err)
        } finally {
            setLoadingNodes(prev => {
                const next = new Set(prev)
                next.delete(parentId)
                return next
            })
        }
    }, [nodes, edges, provider, containmentEdgeTypes, addNodes, addEdges])

    return {
        loadChildren,
        searchChildren,
        isLoading: loadingNodes.size > 0,
        loadingNodes,
        failedNodes,
    }
}
