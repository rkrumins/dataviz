/**
 * Up-converts a view's stored `referenceLayout` config (canonical or
 * legacy) into the canonical shape: layer definitions + a flattened
 * physical-root-urn -> layer assignment map. The layer config is a pure
 * virtual overlay of the physical graph — it stores no graph data;
 * descendants/nesting resolve live via ontology containment elsewhere.
 *
 * Mirrors backend/app/services/layout_config.py — keep the two in sync.
 */
import type { LayerAssignmentEntry, LogicalNodeConfig, ViewContentConfig, ViewLayerConfig } from '@/types/schema'

export interface NormalizedReferenceLayout {
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}

const GLOB_CHARS = /[*?]/

function isExactUrnPattern(pattern: unknown): pattern is string {
    return typeof pattern === 'string' && pattern.length > 0 && !GLOB_CHARS.test(pattern)
}

/**
 * Depth-first, pre-order walk of a logicalNodes tree (arbitrary nesting via
 * `children[]`): converts each node's own exact-urn rules before descending
 * into its children, so a collision between a parent's rule and a
 * descendant's rule leaves the parent's entry in place (first-claimed wins).
 */
function collectLogicalNodeRuleAssignments(
    nodes: LogicalNodeConfig[] | undefined,
    layerId: string,
    assignments: Record<string, LayerAssignmentEntry>,
): void {
    for (const node of nodes ?? []) {
        for (const rule of node.rules ?? []) {
            if (isExactUrnPattern(rule.urnPattern) && !assignments[rule.urnPattern]) {
                assignments[rule.urnPattern] = {
                    layerId,
                    logicalNodeId: node.id,
                    inheritsChildren: true,
                    assignedBy: 'rule',
                }
            }
        }
        collectLogicalNodeRuleAssignments(node.children, layerId, assignments)
    }
}

/**
 * normalizeReferenceLayout rules (earlier wins on key collision):
 * 1. existing top-level `assignments` entries
 * 2. per-layer `entityAssignments[]` (keyed by urn, falling back to entityId; priority dropped)
 * 3. exact-urn (non-glob) layer/logicalNode `rules[]` — logicalNodes are walked
 *    depth-first, pre-order (a node's own rules before its `children[]`, at
 *    any nesting depth), layers in array order.
 *
 * Never mutates `raw`. Glob rules are left in place, untouched, wherever
 * they sit. `entityAssignments` is stripped from returned layers — it is
 * legacy input only, never canonical output.
 */
export function normalizeReferenceLayout(raw: unknown): NormalizedReferenceLayout {
    if (!raw || typeof raw !== 'object') {
        return { layers: [], assignments: {} }
    }
    const source = raw as { layers?: unknown; assignments?: unknown }
    const assignments: Record<string, LayerAssignmentEntry> = {}

    if (source.assignments && typeof source.assignments === 'object') {
        for (const [key, value] of Object.entries(source.assignments as Record<string, unknown>)) {
            if (value && typeof value === 'object') {
                assignments[key] = value as LayerAssignmentEntry
            }
        }
    }

    const rawLayers = Array.isArray(source.layers) ? source.layers : []
    const layers: ViewLayerConfig[] = rawLayers.map((rawLayer: unknown) => {
        if (!rawLayer || typeof rawLayer !== 'object') {
            return rawLayer as ViewLayerConfig
        }
        const layer = rawLayer as ViewLayerConfig & { entityAssignments?: any[] }
        const { entityAssignments, ...rest } = layer

        for (const entry of entityAssignments ?? []) {
            const key = entry?.urn ?? entry?.entityId
            if (!key || assignments[key]) continue
            assignments[key] = {
                layerId: layer.id,
                logicalNodeId: entry.logicalNodeId,
                inheritsChildren: entry.inheritsChildren ?? true,
                assignedBy: entry.assignedBy,
                assignedAt: entry.assignedAt,
            }
        }

        for (const rule of layer.rules ?? []) {
            if (isExactUrnPattern(rule.urnPattern) && !assignments[rule.urnPattern]) {
                assignments[rule.urnPattern] = {
                    layerId: layer.id,
                    inheritsChildren: true,
                    assignedBy: 'rule',
                }
            }
        }

        collectLogicalNodeRuleAssignments(layer.logicalNodes, layer.id, assignments)

        return rest as ViewLayerConfig
    })

    return { layers, assignments }
}

/**
 * Explicit `content.entityScope` wins (only the exact values 'all' or
 * 'curated' count as explicit — anything else falls through to
 * derivation, matching derive_entity_scope in layout_config.py); else
 * derived from whether any layer assignments exist.
 */
export function deriveEntityScope(
    content: ViewContentConfig | undefined,
    layout: NormalizedReferenceLayout,
): 'all' | 'curated' {
    if (content?.entityScope === 'all' || content?.entityScope === 'curated') {
        return content.entityScope
    }
    return Object.keys(layout.assignments).length > 0 ? 'curated' : 'all'
}
