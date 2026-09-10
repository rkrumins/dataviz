/**
 * useCanvasViewRoots — finds the top-level container nodes that
 * define the boundary of the *current view* on the canvas.
 *
 * A "view root" is a node that has no incoming containment edge from
 * another canvas node AND whose entity type is a known root type
 * (from the ontology). For the Data Pipeline view, this returns the
 * top-level containers visible at the tree's first level: SILVER,
 * INTERMEDIATE_T1, INTERMEDIATE_T2, GOLD, REPORTING, Tableau, etc.
 *
 * Used by two consumers:
 *   1. The "Root nodes in view" filter (renamed from "Layer") — the
 *      filter editor lists these URNs by display name; selecting one
 *      or more emits a DescendantOf predicate.
 *
 *   2. ``displayRuleEval`` — the same boundary, evaluated client-side.
 *
 * Search is NOT one of them any more: ``useAdvancedSearch`` used to ship
 * these URNs as ``scope.rootUrns``, but the backend resolves the view's
 * roots from ``scope.viewId`` itself.
 *
 * The logic mirrors EntityAssignmentPanel.tsx (the view wizard's
 * assignment step), which is the canonical place where the
 * application identifies "view roots" today.
 */
import { useMemo } from 'react'

import type { LineageEdge, LineageNode } from '@/store/canvas'
import { useCanvasStore } from '@/store/canvas'
import {
    isContainmentEdgeType,
    normalizeEdgeType,
    useContainmentEdgeTypes,
    useRootEntityTypes,
} from '@/store/schema'


export interface CanvasViewRoot {
    /** Stable identity used as the React key. Equal to ``urn`` in
     *  practice — the canvas store keys nodes by URN. */
    id: string
    urn: string
    /** Human-readable label used in pickers (e.g. ``"SILVER"``). */
    displayName: string
    /** Ontology entity-type id (lowercase per project convention). */
    entityType: string
}


/**
 * Pure helper — used both by the hook (React render path) and by
 * ``displayRuleEval`` which reads canvas state inside a callback and
 * therefore can't call hooks.
 */
export function computeViewRoots(
    nodes: ReadonlyArray<LineageNode>,
    edges: ReadonlyArray<LineageEdge>,
    containmentEdgeTypes: ReadonlyArray<string>,
    rootEntityTypes: ReadonlyArray<string>,
): CanvasViewRoot[] {
    if (!nodes.length) return []

    // Index containment-edge targets so we can ask "does this node
    // have a parent on-canvas?".
    const hasParent = new Set<string>()
    for (const edge of edges) {
        if (!isContainmentEdgeType(
            normalizeEdgeType(edge),
            containmentEdgeTypes as string[],
        )) continue
        hasParent.add(edge.target)
    }

    const rootTypeSet = new Set(rootEntityTypes.map((t) => t.toLowerCase()))
    const matchesRootType = (et: string | undefined) =>
        rootTypeSet.size === 0
        || rootTypeSet.has((et ?? '').toLowerCase())

    const roots: CanvasViewRoot[] = []
    for (const n of nodes) {
        const type = (n.data as { type?: string }).type
        if (!type || type === 'ghost') continue
        if (hasParent.has(n.id)) continue
        if (!matchesRootType(type)) continue
        const urn = (n.data as { urn?: string }).urn ?? n.id
        const label =
            (n.data as { label?: string; businessLabel?: string }).label
            ?? (n.data as { businessLabel?: string }).businessLabel
            ?? urn
        roots.push({
            id: n.id,
            urn,
            displayName: label,
            entityType: type,
        })
    }
    roots.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return roots
}


/**
 * Convenience for callback consumers that need just the URN list and
 * have access to the live canvas + schema state via ``getState()``.
 */
export function computeViewRootUrns(
    nodes: ReadonlyArray<LineageNode>,
    edges: ReadonlyArray<LineageEdge>,
    containmentEdgeTypes: ReadonlyArray<string>,
    rootEntityTypes: ReadonlyArray<string>,
): string[] {
    return computeViewRoots(nodes, edges, containmentEdgeTypes, rootEntityTypes)
        .map((r) => r.urn)
}


/**
 * Returns the canvas's view roots (top-level containers), sorted by
 * display name. Refreshes on canvas mutation.
 */
export function useCanvasViewRoots(): CanvasViewRoot[] {
    const nodes = useCanvasStore((s) => s.nodes)
    const edges = useCanvasStore((s) => s.edges)
    const containmentEdgeTypes = useContainmentEdgeTypes()
    const rootEntityTypes = useRootEntityTypes()
    return useMemo(
        () => computeViewRoots(nodes, edges, containmentEdgeTypes, rootEntityTypes),
        [nodes, edges, containmentEdgeTypes, rootEntityTypes],
    )
}


export function useCanvasViewRootUrns(): string[] {
    const roots = useCanvasViewRoots()
    return useMemo(() => roots.map((r) => r.urn), [roots])
}


/**
 * Top-level containment parents on the canvas — nodes that have at
 * least one HAS-child but no HAS-parent on canvas. Type-agnostic, so
 * it works for ontologies where ``rootEntityTypes`` is narrowly
 * declared (e.g. only 'dashboard') and the real top-level containers
 * are typed 'Container', 'DataPlatform', etc.
 *
 * Returns the 6 visible canvas containers in this view (SILVER,
 * INTERMEDIATE_T1, INTERMEDIATE_T2, GOLD, REPORTING, Tableau) by
 * structural definition: each is the parent of one or more
 * containment children, and itself has no containment parent on the
 * loaded canvas.
 *
 * Powers the "Root in view is…" picker, which previously fed from
 * ``useCanvasViewRoots`` and broke whenever the ontology's root
 * entity-type set didn't include the container entity types the user
 * actually sees on canvas.
 */
export function useTopLevelCanvasContainers(): CanvasViewRoot[] {
    const nodes = useCanvasStore((s) => s.nodes)
    const edges = useCanvasStore((s) => s.edges)
    const containmentEdgeTypes = useContainmentEdgeTypes()
    return useMemo(() => {
        const hasParent = new Set<string>()
        const hasChild = new Set<string>()
        for (const edge of edges) {
            if (!isContainmentEdgeType(
                normalizeEdgeType(edge),
                containmentEdgeTypes as string[],
            )) continue
            hasParent.add(edge.target)
            hasChild.add(edge.source)
        }
        const out: CanvasViewRoot[] = []
        const seen = new Set<string>()
        for (const n of nodes) {
            if (hasParent.has(n.id)) continue
            if (!hasChild.has(n.id)) continue
            const data = n.data as {
                type?: string
                urn?: string
                label?: string
                businessLabel?: string
            }
            if (!data.type || data.type === 'ghost') continue
            const urn = data.urn ?? n.id
            if (seen.has(urn)) continue
            seen.add(urn)
            const label = data.label ?? data.businessLabel ?? urn
            out.push({ id: n.id, urn, displayName: label, entityType: data.type })
        }
        out.sort((a, b) => a.displayName.localeCompare(b.displayName))
        return out
    }, [nodes, edges, containmentEdgeTypes])
}


/**
 * Anchor options for the "Inside Subtree" filter — every node
 * currently loaded on the canvas, regardless of entity type or
 * containment depth. Lets the user pick any Layer, Object, Container,
 * or deeper node as a search anchor; the BE Cypher
 * (``MATCH (root)-[:CONTAINS*0..D]->(n) WHERE root.urn IN $_rootUrns``)
 * has no label restriction.
 *
 * Ghosts and untyped placeholders are filtered out. Sorted by
 * displayName so the dropdown reads alphabetically.
 */
export function useCanvasAnchorOptions(): CanvasViewRoot[] {
    const nodes = useCanvasStore((s) => s.nodes)
    return useMemo(() => {
        const out: CanvasViewRoot[] = []
        const seen = new Set<string>()
        for (const n of nodes) {
            const type = (n.data as { type?: string }).type
            if (!type || type === 'ghost') continue
            const urn = (n.data as { urn?: string }).urn ?? n.id
            if (seen.has(urn)) continue
            seen.add(urn)
            const label =
                (n.data as { label?: string; businessLabel?: string }).label
                ?? (n.data as { businessLabel?: string }).businessLabel
                ?? urn
            out.push({ id: n.id, urn, displayName: label, entityType: type })
        }
        out.sort((a, b) => a.displayName.localeCompare(b.displayName))
        return out
    }, [nodes])
}
