/**
 * How a layout template fits the data a view is about to read.
 *
 * A template's entity types are written for SOME semantic layer. Applied to a
 * view, each type resolves to the target ontology's own spelling (case-folded,
 * the way the canvas matches them) or is dropped and reported — so the wizard
 * can say "matches 3 of 4 layers" and name what didn't, instead of columns
 * silently coming up empty.
 *
 * Rules get the same treatment, logical nodes at any depth included. A rule
 * whose every type is unknown here can never match anything, so it is dropped
 * rather than left to place nothing — or worse, to match every entity once its
 * type list empties; the view's save refuses such a rule anyway.
 *
 * Pure. Layers get fresh ids: the new view owns them.
 */
import { caseFold } from '@/features/ontology/lib/caseFold'
import { generateId } from '@/lib/utils'
import type { LayerAssignmentRuleConfig, LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'

export interface TemplateFit {
    layers: ViewLayerConfig[]
    /** Layers that name entity types, and how many of them kept at least one. */
    typedLayers: number
    matchedLayers: number
    /** Types the template names that the target semantic layer does not declare. */
    unmatchedTypes: string[]
}

function hasCriteria(rule: LayerAssignmentRuleConfig): boolean {
    return !!(rule.entityTypes?.length || rule.tags?.length || rule.urnPattern
        || rule.propertyMatch || rule.conditions?.length)
}

/**
 * `declared` — the target ontology's entity type ids, or null when they are not
 * known (types are then kept exactly as the template has them).
 */
export function fitTemplate(layers: readonly ViewLayerConfig[], declared: readonly string[] | null): TemplateFit {
    const byFold = declared ? new Map(declared.map(t => [caseFold(t), t])) : null
    const unmatched = new Map<string, string>()

    const resolve = (types: readonly string[]): string[] => {
        if (!byFold) return [...types]
        const out: string[] = []
        for (const t of types) {
            const hit = byFold.get(caseFold(t))
            if (hit === undefined) unmatched.set(caseFold(t), t)
            else if (!out.includes(hit)) out.push(hit)
        }
        return out
    }

    const fitRules = (rules: LayerAssignmentRuleConfig[]): LayerAssignmentRuleConfig[] => rules.flatMap(rule => {
        if (!rule.entityTypes?.length) return hasCriteria(rule) ? [rule] : []
        const entityTypes = resolve(rule.entityTypes)
        return entityTypes.length ? [{ ...rule, entityTypes }] : []
    })

    const fitNodes = (nodes: LogicalNodeConfig[]): LogicalNodeConfig[] => nodes.map(node => ({
        ...node,
        ...(node.rules && { rules: fitRules(node.rules) }),
        ...(node.children && { children: fitNodes(node.children) }),
    }))

    let typedLayers = 0
    let matchedLayers = 0
    const fitted = layers.map((layer, i): ViewLayerConfig => {
        const named = layer.entityTypes ?? []
        const entityTypes = resolve(named)
        if (named.length > 0) {
            typedLayers++
            if (entityTypes.length > 0) matchedLayers++
        }
        return {
            ...layer,
            id: generateId(),
            order: i,
            entityTypes,
            ...(layer.rules && { rules: fitRules(layer.rules) }),
            ...(layer.logicalNodes && { logicalNodes: fitNodes(layer.logicalNodes) }),
        }
    })

    return {
        layers: fitted,
        typedLayers,
        matchedLayers,
        unmatchedTypes: [...unmatched.values()].sort((a, b) => a.localeCompare(b)),
    }
}
