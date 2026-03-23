/**
 * ELK Layout Web Worker
 * 
 * Performs ELK.js layout computation off the main thread.
 * Receives nodes and edges, returns positioned nodes.
 */

import ELK from 'elkjs/lib/elk.bundled.js'

const elk = new ELK()

export interface ElkWorkerMessage {
    type: 'layout'
    nodes: ElkInputNode[]
    edges: ElkInputEdge[]
    options: ElkLayoutOptions
    pinnedNodes?: Record<string, { x: number; y: number }>
}

export interface ElkInputNode {
    id: string
    width: number
    height: number
    type?: string
    parentId?: string
}

export interface ElkInputEdge {
    id: string
    source: string
    target: string
}

export interface ElkLayoutOptions {
    direction: 'LR' | 'TB'
    layerSpacing: number
    nodeSpacing: number
}

export interface ElkWorkerResult {
    type: 'layout-complete' | 'error'
    nodes?: Array<{ id: string; x: number; y: number }>
    error?: string
}

/**
 * Build ELK graph structure from flat nodes/edges
 * Handles parent-child relationships for hierarchical layout
 */
function buildElkGraph(
    nodes: ElkInputNode[],
    edges: ElkInputEdge[],
    options: ElkLayoutOptions,
    pinnedNodes?: Record<string, { x: number; y: number }>
) {
    // Determine ELK direction
    const elkDirection = options.direction === 'TB' ? 'DOWN' : 'RIGHT'

    // Base layout options
    const layoutOptions = {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection,
        'elk.layered.spacing.nodeNodeBetweenLayers': String(options.layerSpacing),
        'elk.spacing.nodeNode': String(options.nodeSpacing),
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.separateConnectedComponents': 'false',
        // Better edge routing
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
    }

    // Build parent-child map
    const childrenByParent = new Map<string, ElkInputNode[]>()
    const rootNodes: ElkInputNode[] = []

    nodes.forEach(node => {
        if (node.parentId) {
            if (!childrenByParent.has(node.parentId)) {
                childrenByParent.set(node.parentId, [])
            }
            childrenByParent.get(node.parentId)!.push(node)
        } else {
            rootNodes.push(node)
        }
    })

    // Recursively build ELK node structure
    function buildElkNode(node: ElkInputNode): Record<string, unknown> {
        const children = childrenByParent.get(node.id) || []
        const isPinned = pinnedNodes && pinnedNodes[node.id]

        const elkNode: Record<string, unknown> = {
            id: node.id,
            width: node.width,
            height: node.height,
            // If pinned, lock position
            ...(isPinned ? { x: isPinned.x, y: isPinned.y } : {}),
            layoutOptions: isPinned ? {
                'elk.position': `(${isPinned.x}, ${isPinned.y})`,
            } : {},
        }

        if (children.length > 0) {
            elkNode.children = children.map(buildElkNode)
            // Add padding for parent nodes
            elkNode.layoutOptions = {
                ...(elkNode.layoutOptions as Record<string, unknown>),
                'elk.padding': '[top=60,left=20,bottom=20,right=20]',
            }
        }

        return elkNode
    }

    // Map edges to ELK format
    const elkEdges = edges.map(edge => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
    }))

    return {
        id: 'root',
        layoutOptions,
        children: rootNodes.map(buildElkNode),
        edges: elkEdges,
    }
}

/**
 * Extract flat positioned nodes from ELK result
 */
function extractPositions(
    elkGraph: Record<string, unknown>,
    offsetX = 0,
    offsetY = 0
): Array<{ id: string; x: number; y: number }> {
    const positions: Array<{ id: string; x: number; y: number }> = []

    const children = elkGraph.children as Array<Record<string, unknown>> | undefined
    if (!children) return positions

    for (const child of children) {
        const x = (child.x as number) + offsetX
        const y = (child.y as number) + offsetY

        positions.push({
            id: child.id as string,
            x,
            y,
        })

        // Recursively extract nested children
        if (child.children) {
            positions.push(...extractPositions(child as Record<string, unknown>, x, y))
        }
    }

    return positions
}

// Worker message handler
self.onmessage = async (event: MessageEvent<ElkWorkerMessage>) => {
    const { type, nodes, edges, options, pinnedNodes } = event.data

    if (type !== 'layout') {
        return
    }

    try {
        const elkGraph = buildElkGraph(nodes, edges, options, pinnedNodes)
        // Cast through unknown to satisfy TypeScript - our structure is compatible with ELK's expected format
        const layoutedGraph = await elk.layout(elkGraph as unknown as Parameters<typeof elk.layout>[0])
        const positions = extractPositions(layoutedGraph as unknown as Record<string, unknown>)

        const result: ElkWorkerResult = {
            type: 'layout-complete',
            nodes: positions,
        }

        self.postMessage(result)
    } catch (error) {
        const result: ElkWorkerResult = {
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
        }
        self.postMessage(result)
    }
}
