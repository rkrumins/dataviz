/**
 * What a layout template's new version means for a view built from an older one.
 *
 * Three sides: the template as the view got it (BASE — the version the view
 * last matched), the template now (THEIRS), and the view's own layers (OURS),
 * matched to the template's by `templateLayerId`. Template sides are first made
 * the way the view got them (`layersForView`: types resolved against the view's
 * semantic layer, the defaults filled in), so a type the view's data lacks, or a
 * colour the template never set, is not mistaken for a change.
 *
 * Per layer and per field: what the template changed and the view did not is
 * taken; what the view changed and the template did not is kept; where both
 * changed it differently the view's value stays unless the person chooses the
 * template's. A layer the template dropped goes only if the view neither placed
 * entities in it nor edited it. A layer the template added arrives where its
 * neighbours are. Layers the view made itself are never touched.
 *
 * Pure, and idempotent: planning again after applying finds nothing to do.
 */
import { generateId } from '@/lib/utils'
import type { LayerAssignmentEntry, LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'
import { layersForView } from './templateFit'

/** What a template decides about a layer. Everything else (id, order, width,
 *  sort, anchor, scope edges) is the view's own. */
export const TEMPLATE_FIELDS = [
    'name', 'description', 'icon', 'color', 'entityTypes', 'rules', 'logicalNodes', 'showUnassigned',
] as const
export type TemplateField = typeof TEMPLATE_FIELDS[number]

export interface FieldChange {
    /** `${templateLayerId}:${field}` — the decision key. */
    key: string
    field: TemplateField
    ours: unknown
    theirs: unknown
    conflict: boolean
}

export type UpdateRow =
    | { kind: 'added'; key: string; name: string; layer: ViewLayerConfig }
    | { kind: 'changed'; key: string; name: string; viewLayerId: string; fields: FieldChange[] }
    | { kind: 'removed'; key: string; name: string; viewLayerId: string; placed: number; edited: boolean; conflict: boolean }
    /** The view deleted this layer and the template has since changed it. */
    | { kind: 'restorable'; key: string; name: string; layer: ViewLayerConfig }

export interface TemplateUpdatePlan {
    /** Whether any of the view's layers still come from the template. */
    follows: boolean
    rows: UpdateRow[]
    /** The template reordered layers both share; a conflict when the view did too. */
    order: { conflict: boolean } | null
}

export interface TemplateUpdateInput {
    /** The template's layers at the version the view last matched. */
    base: readonly ViewLayerConfig[]
    /** The template's layers now. */
    latest: readonly ViewLayerConfig[]
    view: { layers: readonly ViewLayerConfig[]; assignments: Readonly<Record<string, LayerAssignmentEntry>> }
    /** The view's semantic layer's entity types, or null when not known. */
    declared: readonly string[] | null
}

export const ORDER_KEY = 'order'

// ── Comparing ────────────────────────────────────────────────────────

function absent(v: unknown): boolean {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort()
            .filter(k => !absent((v as Record<string, unknown>)[k]))
            .map(k => [k, canonical((v as Record<string, unknown>)[k])]))
    }
    return v
}

/** Equal as a person would mean it: empty is empty, key order is noise, and
 *  the entity types a column collects are a set. */
export function sameField(field: TemplateField, a: unknown, b: unknown): boolean {
    if (absent(a) && absent(b)) return true
    if (field === 'entityTypes' && Array.isArray(a) && Array.isArray(b)) {
        return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    }
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function field(layer: ViewLayerConfig, f: TemplateField): unknown {
    return (layer as unknown as Record<string, unknown>)[f]
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i])
}

// ── Planning ─────────────────────────────────────────────────────────

interface Sides {
    B: Map<string, ViewLayerConfig>
    T: Map<string, ViewLayerConfig>
    tOrder: string[]
    bOrder: string[]
    /** Template layer id → the view's layer made from it (the first, if copied). */
    O: Map<string, ViewLayerConfig>
}

function sides(input: TemplateUpdateInput): Sides {
    const fit = (layers: readonly ViewLayerConfig[]) =>
        layersForView(layers, input.declared).map(l => [l.templateLayerId as string, l] as const)
    const B = new Map(fit(input.base))
    const T = new Map(fit(input.latest))
    const O = new Map<string, ViewLayerConfig>()
    for (const layer of input.view.layers) {
        const tid = layer.templateLayerId
        if (tid && (B.has(tid) || T.has(tid)) && !O.has(tid)) O.set(tid, layer)
    }
    return { B, T, O, tOrder: [...T.keys()], bOrder: [...B.keys()] }
}

function placedIn(assignments: TemplateUpdateInput['view']['assignments'], layerId: string): number {
    return Object.values(assignments).filter(a => a.layerId === layerId).length
}

export function planTemplateUpdate(input: TemplateUpdateInput): TemplateUpdatePlan {
    const { B, T, O, tOrder, bOrder } = sides(input)
    const rows: UpdateRow[] = []
    const changedBetween = (b: ViewLayerConfig, t: ViewLayerConfig) =>
        TEMPLATE_FIELDS.some(f => !sameField(f, field(b, f), field(t, f)))

    for (const tid of [...tOrder, ...bOrder.filter(id => !T.has(id))]) {
        const b = B.get(tid)
        const t = T.get(tid)
        const o = O.get(tid)
        if (t && o) {
            const fields: FieldChange[] = []
            for (const f of TEMPLATE_FIELDS) {
                const theirs = field(t, f)
                const ours = field(o, f)
                if (b && sameField(f, field(b, f), theirs)) continue   // the template left it alone
                if (sameField(f, ours, theirs)) continue                // already the same
                const untouched = b !== undefined && sameField(f, ours, field(b, f))
                fields.push({ key: `${tid}:${f}`, field: f, ours, theirs, conflict: !untouched })
            }
            if (fields.length) rows.push({ kind: 'changed', key: tid, name: o.name, viewLayerId: o.id, fields })
        } else if (t && !b) {
            rows.push({ kind: 'added', key: tid, name: t.name, layer: t })
        } else if (t && b && changedBetween(b, t)) {
            rows.push({ kind: 'restorable', key: tid, name: t.name, layer: t })
        } else if (b && o && !t) {
            const placed = placedIn(input.view.assignments, o.id)
            const edited = TEMPLATE_FIELDS.some(f => !sameField(f, field(o, f), field(b, f)))
            rows.push({
                kind: 'removed', key: tid, name: o.name, viewLayerId: o.id,
                placed, edited, conflict: placed > 0 || edited,
            })
        }
    }

    // Order, over the layers all three share.
    const shared = (order: readonly string[]) => order.filter(id => B.has(id) && T.has(id) && O.has(id))
    const viewOrder = shared(input.view.layers.flatMap(l => (l.templateLayerId && O.get(l.templateLayerId) === l ? [l.templateLayerId] : [])))
    const baseOrder = shared(bOrder)
    const theirOrder = shared(tOrder)
    const templateMoved = !sameOrder(theirOrder, baseOrder)
    const viewMoved = !sameOrder(viewOrder, baseOrder)
    const order = templateMoved && !sameOrder(viewOrder, theirOrder) ? { conflict: viewMoved } : null

    return { follows: O.size > 0, rows, order }
}

/** What applying does when nobody chooses: every change without a conflict. */
export function defaultChoices(plan: TemplateUpdatePlan): Set<string> {
    const take = new Set<string>()
    for (const row of plan.rows) {
        if (row.kind === 'added') take.add(row.key)
        if (row.kind === 'removed' && !row.conflict) take.add(row.key)
        if (row.kind === 'changed') row.fields.filter(f => !f.conflict).forEach(f => take.add(f.key))
    }
    if (plan.order && !plan.order.conflict) take.add(ORDER_KEY)
    return take
}

// ── Applying ─────────────────────────────────────────────────────────

function nodeIds(nodes: LogicalNodeConfig[] | undefined, into = new Set<string>()): Set<string> {
    for (const n of nodes ?? []) {
        into.add(n.id)
        nodeIds(n.children, into)
    }
    return into
}

/**
 * The view's layers and placements with the chosen changes made. `take` holds
 * the decision keys to apply (see `defaultChoices`); `newId` names new columns.
 */
export function applyTemplateUpdate(
    input: TemplateUpdateInput,
    plan: TemplateUpdatePlan,
    take: ReadonlySet<string>,
    newId: () => string = generateId,
): { layers: ViewLayerConfig[]; assignments: Record<string, LayerAssignmentEntry> } {
    const { O, tOrder } = sides(input)
    let layers: ViewLayerConfig[] = input.view.layers.map(l => ({ ...l }))
    let assignments: Record<string, LayerAssignmentEntry> = { ...input.view.assignments }
    const scopeEdges = input.view.layers[0]?.scopeEdges
    const fresh = (t: ViewLayerConfig): ViewLayerConfig => ({
        ...t, id: newId(), ...(scopeEdges && { scopeEdges }),
    })
    const arriving: ViewLayerConfig[] = []

    for (const row of plan.rows) {
        if (!take.has(row.key) && row.kind !== 'changed') continue
        if (row.kind === 'changed') {
            const at = layers.findIndex(l => l.id === row.viewLayerId)
            const next = { ...layers[at] } as unknown as Record<string, unknown>
            let nodesTaken = false
            for (const f of row.fields) {
                if (!take.has(f.key)) continue
                if (absent(f.theirs)) delete next[f.field]
                else next[f.field] = f.theirs
                nodesTaken ||= f.field === 'logicalNodes'
            }
            layers[at] = next as unknown as ViewLayerConfig
            if (nodesTaken) {
                const kept = nodeIds(layers[at].logicalNodes)
                assignments = Object.fromEntries(Object.entries(assignments).map(([urn, a]) => {
                    if (a.layerId !== row.viewLayerId || !a.logicalNodeId || kept.has(a.logicalNodeId)) return [urn, a]
                    const rest = { ...a }
                    delete rest.logicalNodeId
                    return [urn, rest]
                }))
            }
        } else if (row.kind === 'removed') {
            layers = layers.filter(l => l.id !== row.viewLayerId)
            assignments = Object.fromEntries(Object.entries(assignments).filter(([, a]) => a.layerId !== row.viewLayerId))
        } else {
            arriving.push(fresh(row.layer))
        }
    }

    // The template's order, in the slots its layers hold — the view's own
    // layers stay exactly where they are.
    if (plan.order && take.has(ORDER_KEY)) {
        const rank = new Map(tOrder.map((tid, i) => [tid, i]))
        const mapped = new Set([...O.values()].map(l => l.id))
        const follows = (l: ViewLayerConfig) => mapped.has(l.id) && rank.has(l.templateLayerId!)
        const sorted = layers.filter(follows).sort((a, b) => rank.get(a.templateLayerId!)! - rank.get(b.templateLayerId!)!)
        let next = 0
        layers = layers.map(l => (follows(l) ? sorted[next++] : l))
    }

    // New columns go after the nearest template neighbour the view has, else
    // before the nearest one after it, else at the end.
    for (const layer of arriving) {
        const at = tOrder.indexOf(layer.templateLayerId!)
        const present = (tid: string) => layers.findIndex(l => l.templateLayerId === tid)
        const before = tOrder.slice(0, at).reverse().map(present).find(i => i >= 0)
        const after = tOrder.slice(at + 1).map(present).find(i => i >= 0)
        const index = before !== undefined ? before + 1 : after !== undefined ? after : layers.length
        layers.splice(index, 0, layer)
    }
    return { layers: layers.map((l, i) => ({ ...l, order: i })), assignments }
}

// ── Comparing two versions of a template ─────────────────────────────

export interface LayerDiff {
    kind: 'added' | 'removed' | 'changed'
    id: string
    name: string
    fields: TemplateField[]
}

/** How `to` differs from `from`, layer by layer (by template layer id). */
export function diffTemplateLayers(from: readonly ViewLayerConfig[], to: readonly ViewLayerConfig[]): LayerDiff[] {
    const before = new Map(from.map(l => [l.id, l]))
    const after = new Map(to.map(l => [l.id, l]))
    const out: LayerDiff[] = []
    for (const l of to) {
        const was = before.get(l.id)
        if (!was) out.push({ kind: 'added', id: l.id, name: l.name, fields: [] })
        else {
            const fields = TEMPLATE_FIELDS.filter(f => !sameField(f, field(was, f), field(l, f)))
            if (fields.length) out.push({ kind: 'changed', id: l.id, name: l.name, fields })
        }
    }
    for (const l of from) if (!after.has(l.id)) out.push({ kind: 'removed', id: l.id, name: l.name, fields: [] })
    return out
}
