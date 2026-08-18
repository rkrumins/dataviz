/**
 * traceWalkMerge — pure delta-merge of a closure walk model (the Lineage
 * Lens's accumulated `LensWalkModel`) into canvas-store shapes, for the
 * NATIVE canvas trace.
 *
 * Applies the legacy trace-merge rules verbatim — each exists because of a
 * shipped bug (see ContextViewCanvas's onTraceComplete path and
 * [[traceMergeSpine]]):
 *
 *  - `computeTraceMergeSpine` decides which returned ancestors may merge
 *    (the minimum chain routing every NEW participant to a known anchor);
 *  - only HYDRATED nodes (a real displayName) become cards — a dangling
 *    reference renders as a phantom box;
 *  - lineage edges only between resolvable endpoints (known on canvas,
 *    merged earlier this session, or merged by this very call);
 *  - containment edges NEVER target an already-known node — re-parenting
 *    an existing node collapses its layer assignment (the HARD RULE);
 *  - pure and idempotent: the session records what has merged, so the same
 *    model twice yields an empty delta, and a grown model yields only the
 *    growth.
 *
 * A participant whose ancestor chain reaches no known anchor still merges:
 * the layer-assignment chain decides whether it renders (falling out of
 * `nodesByLayer` is the deliberate curated-view behaviour; the trace bar
 * counts it honestly).
 */
import { computeTraceMergeSpine } from './traceMergeSpine'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

export interface TraceWalkMergeSession {
    readonly mergedNodeIds: ReadonlySet<string>
    readonly mergedEdgeIds: ReadonlySet<string>
}

export function emptyTraceWalkMergeSession(): TraceWalkMergeSession {
    return { mergedNodeIds: new Set(), mergedEdgeIds: new Set() }
}

export interface TraceWalkMergeDelta {
    nodes: Array<{ id: string; type: 'default'; position: { x: number; y: number }; data: Record<string, unknown> }>
    edges: Array<{ id: string; source: string; target: string; data: { edgeType: string; relationship: string } }>
}

export function computeTraceWalkDelta(opts: {
    model: LensWalkModel
    session: TraceWalkMergeSession
    /** urns/ids already on the canvas (store node ids) — the spine's anchors. */
    knownUrns: ReadonlySet<string>
}): { delta: TraceWalkMergeDelta; session: TraceWalkMergeSession } {
    const { model, session, knownUrns } = opts

    const participantUrns = new Set<string>()
    for (const n of model.nodes) participantUrns.add(n.urn)
    for (const u of model.upstreamUrns) participantUrns.add(u)
    for (const u of model.downstreamUrns) participantUrns.add(u)

    const { spineUrns } = computeTraceMergeSpine({
        participantUrns,
        containmentEdges: model.containmentEdges,
        knownAssignedUrns: knownUrns,
    })

    const hydrated = new Set<string>()
    for (const n of model.nodes) {
        if ((n.displayName ?? '').trim().length > 0) hydrated.add(n.urn)
    }

    const mergeableUrn = (urn: string): boolean =>
        (participantUrns.has(urn) || spineUrns.has(urn))
        && !knownUrns.has(urn)
        && hydrated.has(urn)

    const newNodeIds = new Set<string>()
    const nodes: TraceWalkMergeDelta['nodes'] = []
    for (const n of model.nodes) {
        if (!mergeableUrn(n.urn)) continue
        if (session.mergedNodeIds.has(n.urn)) continue
        newNodeIds.add(n.urn)
        nodes.push({ id: n.urn, type: 'default', position: { x: 0, y: 0 }, data: n.data as Record<string, unknown> })
    }

    const resolvable = (urn: string): boolean =>
        knownUrns.has(urn) || session.mergedNodeIds.has(urn) || newNodeIds.has(urn)

    const edges: TraceWalkMergeDelta['edges'] = []
    const newEdgeIds = new Set<string>()
    const pushEdge = (id: string, source: string, target: string, edgeType: string) => {
        if (session.mergedEdgeIds.has(id) || newEdgeIds.has(id)) return
        newEdgeIds.add(id)
        edges.push({ id, source, target, data: { edgeType, relationship: edgeType } })
    }

    for (const e of model.lineageEdges) {
        if (!resolvable(e.sourceUrn) || !resolvable(e.targetUrn)) continue
        pushEdge(
            e.id ?? `tw:${e.sourceUrn}>${e.targetUrn}:${e.edgeType ?? ''}`,
            e.sourceUrn, e.targetUrn, e.edgeType ?? 'LINEAGE',
        )
    }

    for (const e of model.containmentEdges) {
        // HARD RULE: only a node merged THIS session may gain a parent.
        const targetIsMerged = newNodeIds.has(e.targetUrn) || session.mergedNodeIds.has(e.targetUrn)
        if (!targetIsMerged || !resolvable(e.sourceUrn)) continue
        const withExtras = e as { id?: string; edgeType?: string }
        pushEdge(
            withExtras.id ?? `twc:${e.sourceUrn}>${e.targetUrn}`,
            e.sourceUrn, e.targetUrn, withExtras.edgeType ?? 'CONTAINS',
        )
    }

    if (nodes.length === 0 && edges.length === 0) return { delta: { nodes, edges }, session }

    const mergedNodeIds = new Set(session.mergedNodeIds)
    for (const id of newNodeIds) mergedNodeIds.add(id)
    const mergedEdgeIds = new Set(session.mergedEdgeIds)
    for (const id of newEdgeIds) mergedEdgeIds.add(id)
    return { delta: { nodes, edges }, session: { mergedNodeIds, mergedEdgeIds } }
}

/**
 * The containment ancestors of every model participant — what the canvas
 * must EXPAND so the whole flow is visible upfront. Walks child→parent
 * from the model's own containment edges; cycle-safe via a per-walk
 * visited set (a cycle terminates and simply contributes its members).
 */
export function traceExpansionUrns(model: LensWalkModel): Set<string> {
    const childToParent = new Map<string, string>()
    for (const e of model.containmentEdges) {
        if (e.sourceUrn && e.targetUrn) childToParent.set(e.targetUrn, e.sourceUrn)
    }
    const out = new Set<string>()
    for (const n of model.nodes) {
        const seen = new Set<string>([n.urn])
        let cursor = childToParent.get(n.urn)
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            out.add(cursor)
            cursor = childToParent.get(cursor)
        }
    }
    return out
}
