/**
 * A Context View's layers as a template keeps them: every structural field, and
 * nothing that names an entity of that view's graph — a column's `anchorUrn`,
 * legacy `entityAssignments`, and exact-URN rules (placements in all but name)
 * on layers and logical nodes. The server strips the same fields
 * (`layout_config.strip_placements`); doing it here too keeps the preview honest.
 */
import type { LayerAssignmentRuleConfig, LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'

/** A pattern with no wildcard names one entity. Same test as `referenceLayout.ts`. */
function isExactUrn(pattern: unknown): boolean {
    return typeof pattern === 'string' && pattern.length > 0 && !pattern.includes('*') && !pattern.includes('?')
}

function keepRules(rules: LayerAssignmentRuleConfig[] | undefined) {
    return rules?.filter(r => !isExactUrn(r.urnPattern))
}

function stripNodes(nodes: LogicalNodeConfig[] | undefined): LogicalNodeConfig[] | undefined {
    return nodes?.map(node => ({
        ...node,
        ...(node.rules && { rules: keepRules(node.rules) }),
        ...(node.children && { children: stripNodes(node.children) }),
    }))
}

export function templateLayers(layers: readonly ViewLayerConfig[]): ViewLayerConfig[] {
    return layers.map(layer => {
        const out: ViewLayerConfig = { ...layer }
        delete out.anchorUrn
        delete out.entityAssignments
        if (layer.rules) out.rules = keepRules(layer.rules)
        if (layer.logicalNodes) out.logicalNodes = stripNodes(layer.logicalNodes)
        return out
    })
}

/** The layers stored in a view's config (canonical or legacy spelling). */
export function layersOfViewConfig(config: unknown): ViewLayerConfig[] {
    const c = (config ?? {}) as { layout?: { referenceLayout?: { layers?: unknown } }; referenceLayout?: { layers?: unknown } }
    const raw = c.layout?.referenceLayout?.layers ?? c.referenceLayout?.layers
    return Array.isArray(raw) ? (raw as ViewLayerConfig[]) : []
}
