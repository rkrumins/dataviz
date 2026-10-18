/**
 * A template against real data, before anyone builds a view from it: which
 * entity types to sample, and which layer each sampled entity lands in — the
 * wizard's own placement (`buildWizardPlacement`), so the preview shows what a
 * view built from the template would.
 */
import { buildWizardPlacement } from '@/components/views/ViewWizard/effectivePlacement'
import { factsFromGraphNode } from '@/lib/placement/placement'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { LayerAssignmentRuleConfig, LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'

/** The entity types a fitted template's layers collect — their rules and
 *  logical nodes included — layer by layer, up to `max`. */
export function sampleTypes(layers: readonly ViewLayerConfig[], max = 8): string[] {
    const out: string[] = []
    const add = (types: readonly string[] | undefined) => {
        for (const t of types ?? []) if (out.length < max && !out.includes(t)) out.push(t)
    }
    const fromRules = (rules: LayerAssignmentRuleConfig[] | undefined) => rules?.forEach(r => add(r.entityTypes))
    const fromNodes = (nodes: LogicalNodeConfig[] | undefined): void => nodes?.forEach(n => {
        fromRules(n.rules)
        fromNodes(n.children)
    })
    for (const layer of [...layers].sort((a, b) => a.order - b.order)) {
        add(layer.entityTypes)
        fromRules(layer.rules)
        fromNodes(layer.logicalNodes)
    }
    return out
}

/** Which layer each sampled entity lands in; what lands nowhere is `unplaced`. */
export function placeSample(layers: ViewLayerConfig[], nodes: readonly GraphNode[], contract: boolean) {
    const place = buildWizardPlacement(layers, {}, 'all', contract)
    const byLayer = new Map<string, GraphNode[]>()
    const unplaced: GraphNode[] = []
    for (const node of nodes) {
        const { layerId } = place({
            urn: node.urn, type: node.entityType, ...(contract ? { facts: factsFromGraphNode(node) } : {}),
        })
        if (layerId) byLayer.set(layerId, [...(byLayer.get(layerId) ?? []), node])
        else unplaced.push(node)
    }
    return { byLayer, unplaced }
}
