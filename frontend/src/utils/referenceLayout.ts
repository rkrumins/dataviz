/**
 * Up-converts a view's stored `referenceLayout` config (canonical or
 * legacy) into the canonical shape: layer definitions + a flattened
 * physical-root-urn -> layer assignment map. The layer config is a pure
 * virtual overlay of the physical graph — it stores no graph data;
 * descendants/nesting resolve live via ontology containment elsewhere.
 *
 * Mirrors backend/app/services/layout_config.py — keep the two in sync.
 */
import type { LayerAssignmentEntry, ViewContentConfig, ViewLayerConfig } from '@/types/schema'

export interface NormalizedReferenceLayout {
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}

const GLOB_CHARS = /[*?]/

function isExactUrnPattern(pattern: unknown): pattern is string {
    return typeof pattern === 'string' && pattern.length > 0 && !GLOB_CHARS.test(pattern)
}

/**
 * normalizeReferenceLayout rules (earlier wins on key collision):
 * 1. existing top-level `assignments` entries
 * 2. per-layer `entityAssignments[]` (keyed by urn, falling back to entityId; priority dropped)
 * 3. exact-urn (non-glob) layer/logicalNode `rules[]`
 *
 * Never mutates `raw`. Glob rules are left in place, untouched, on the
 * returned layer. `entityAssignments` is stripped from returned layers —
 * it is legacy input only, never canonical output.
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

        for (const node of layer.logicalNodes ?? []) {
            for (const rule of node.rules ?? []) {
                if (isExactUrnPattern(rule.urnPattern) && !assignments[rule.urnPattern]) {
                    assignments[rule.urnPattern] = {
                        layerId: layer.id,
                        logicalNodeId: node.id,
                        inheritsChildren: true,
                        assignedBy: 'rule',
                    }
                }
            }
        }

        return rest as ViewLayerConfig
    })

    return { layers, assignments }
}

/** Explicit `content.entityScope` wins; else derived from whether any layer assignments exist. */
export function deriveEntityScope(
    content: ViewContentConfig | undefined,
    layout: NormalizedReferenceLayout,
): 'all' | 'curated' {
    if (content?.entityScope) return content.entityScope
    return Object.keys(layout.assignments).length > 0 ? 'curated' : 'all'
}
