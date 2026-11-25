/**
 * Fitting a layout template to the data a view is about to read.
 *
 * A template is a generic structure: named layers in an order, each with
 * optional type hints written for SOME semantic layer. Applying it fills each
 * layer with this data's own types, and records how they were chosen:
 *
 *   • by name — a hint names one of the data's types: its id, name or plural
 *     name, with case, separators and a plural ending ignored
 *     ("DATA_PRODUCTS" is "dataProduct");
 *   • by level — hinted layers that name matching leaves empty take the data's
 *     hierarchy levels in order, coarsest first. Only levels lying between the
 *     layers matched by name around them, each used once, never a type another
 *     layer already holds, and only in a hierarchy of two levels or more;
 *   • none — nothing fits: the layer stays, for the person to fill.
 *
 * A layer without hints is filled by hand by design and is left so. No layer is
 * ever dropped. When the data's types are not known — no ontology, an empty one,
 * or a schema that could not be read — the hints are kept as written and nothing
 * is claimed about them.
 *
 * Rules are fitted by name, logical nodes at any depth included. A rule whose
 * every type is unknown here can never match anything, so it is dropped rather
 * than left to place nothing — or worse, to match every entity once its type
 * list empties; the view's save refuses such a rule anyway.
 *
 * Pure. Layers get fresh ids — the new view owns them — and remember the
 * template layer each came from (`templateLayerId`), so a later version of the
 * template can be matched to them.
 */
import { caseFold } from '@/features/ontology/lib/caseFold'
import { LAYER_COLORS } from '@/components/views/ViewWizard/layerColors'
import {
    buildHierarchyLevels,
    type HierarchyPreviewEntityType,
    type HierarchyPreviewRelationship,
} from '@/components/views/ViewWizard/OntologyHierarchyPreview'
import { generateId } from '@/lib/utils'
import type { LayerAssignmentRuleConfig, LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'

/** One of the data's entity types, and the names a hint may use for it. */
export interface FitType {
    id: string
    name?: string
    pluralName?: string
}

/** What a template is fitted to: the data's entity types and, when known, its
 *  hierarchy — type ids per level, coarsest first. */
export interface FitTarget {
    types: readonly FitType[]
    levels?: readonly (readonly string[])[]
}

/** How a layer's types were chosen. `template`: the hints as written, the data's
 *  types not being known. */
export type FillSource = 'name' | 'level' | 'template' | 'none'

export interface LayerFill {
    types: string[]
    by: FillSource
}

export interface TemplateFit {
    layers: ViewLayerConfig[]
    /** How each fitted layer is filled, by its new id. */
    fills: Record<string, LayerFill>
    /** Layers with type hints, and how many of them were filled. Both 0 when the
     *  data's types are not known. */
    typedLayers: number
    matchedLayers: number
    /** Hints that name none of the data's types. */
    unmatchedTypes: string[]
}

function hasCriteria(rule: LayerAssignmentRuleConfig): boolean {
    return !!(rule.entityTypes?.length || rule.tags?.length || rule.urnPattern
        || rule.propertyMatch || rule.conditions?.length)
}

/** What a hint and a type's id or name are compared by: case, separators and a
 *  plural ending ignored ("Data_Products" → "dataproduct"). */
export function normaliseTypeName(name: string): string {
    const flat = caseFold(name).replace(/[\s_\-./:]+/g, '')
    if (flat.length > 4 && flat.endsWith('ies')) return `${flat.slice(0, -3)}y`
    if (/(sses|xes|zes|ches|shes)$/.test(flat)) return flat.slice(0, -2)
    if (flat.endsWith('s') && !/(ss|us|is)$/.test(flat)) return flat.slice(0, -1)
    return flat
}

/** Hint → the data's type id: the id case-folded, then the id normalised, then
 *  its name or plural name normalised. */
function typeFinder(types: readonly FitType[]): (hint: string) => string | undefined {
    const byId = new Map<string, string>()
    const byNormalId = new Map<string, string>()
    const byLabel = new Map<string, string>()
    const add = (map: Map<string, string>, key: string, id: string) => {
        if (key && !map.has(key)) map.set(key, id)
    }
    for (const t of types) {
        add(byId, caseFold(t.id), t.id)
        add(byNormalId, normaliseTypeName(t.id), t.id)
        for (const label of [t.name, t.pluralName]) if (label) add(byLabel, normaliseTypeName(label), t.id)
    }
    return hint => byId.get(caseFold(hint)) ?? byNormalId.get(normaliseTypeName(hint)) ?? byLabel.get(normaliseTypeName(hint))
}

function targetOf(data: FitTarget | readonly string[] | null): FitTarget | null {
    if (!data) return null
    const target = Array.isArray(data) ? { types: (data as readonly string[]).map(id => ({ id })) } : data as FitTarget
    return target.types.length > 0 ? target : null
}

/**
 * Empty hinted layers take the hierarchy's levels in order (see the header).
 * Mutates `layers` and `by`, both fresh copies owned by `fitTemplate`.
 */
function fillByLevel(
    layers: ViewLayerConfig[], by: FillSource[], hinted: boolean[], levels: readonly (readonly string[])[],
): void {
    if (levels.length < 2) return
    const held = new Set(layers.flatMap(l => [...l.entityTypes, ...(l.rules ?? []).flatMap(r => r.entityTypes ?? [])]).map(caseFold))
    const levelOf = new Map<string, number>()
    levels.forEach((level, i) => level.forEach(t => { if (!levelOf.has(caseFold(t))) levelOf.set(caseFold(t), i) }))
    const open = levels.map(level => level.filter(t => !held.has(caseFold(t))))

    let floor = -1
    let run: number[] = []
    const fillRun = (ceiling: number) => {
        const slots = open.flatMap((types, j) => (j > floor && j < ceiling && types.length > 0 ? [j] : []))
        run.slice(0, slots.length).forEach((i, k) => {
            layers[i] = { ...layers[i], entityTypes: [...open[slots[k]]] }
            by[i] = 'level'
        })
        run = []
    }
    layers.forEach((layer, i) => {
        if (hinted[i] && layer.entityTypes.length === 0 && !(layer.rules ?? []).some(hasCriteria)) {
            run.push(i)
            return
        }
        const anchor = Math.min(...layer.entityTypes.map(t => levelOf.get(caseFold(t)) ?? Infinity))
        if (Number.isFinite(anchor)) {
            fillRun(anchor)
            floor = Math.max(floor, anchor)
        }
    })
    fillRun(levels.length)
}

/**
 * `data` — the data's entity types (a target, or just their ids), or null when
 * they are not known: the hints are then kept exactly as the template has them.
 */
export function fitTemplate(layers: readonly ViewLayerConfig[], data: FitTarget | readonly string[] | null): TemplateFit {
    const target = targetOf(data)
    const find = target ? typeFinder(target.types) : null
    const unmatched = new Map<string, string>()

    const resolve = (types: readonly string[]): string[] => {
        if (!find) return [...types]
        const out: string[] = []
        for (const t of types) {
            const hit = find(t)
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

    const hinted = layers.map(l => (l.entityTypes?.length ?? 0) > 0)
    const fitted = layers.map((layer, i): ViewLayerConfig => ({
        ...layer,
        id: generateId(),
        templateLayerId: layer.id,
        order: i,
        entityTypes: resolve(layer.entityTypes ?? []),
        ...(layer.rules && { rules: fitRules(layer.rules) }),
        ...(layer.logicalNodes && { logicalNodes: fitNodes(layer.logicalNodes) }),
    }))
    const by = fitted.map((l): FillSource => (l.entityTypes.length === 0 ? 'none' : target ? 'name' : 'template'))
    if (target?.levels) fillByLevel(fitted, by, hinted, target.levels)

    return {
        layers: fitted,
        fills: Object.fromEntries(fitted.map((l, i) => [l.id, { types: l.entityTypes, by: by[i] }])),
        typedLayers: target ? hinted.filter(Boolean).length : 0,
        matchedLayers: target ? fitted.filter((l, i) => hinted[i] && l.entityTypes.length > 0).length : 0,
        unmatchedTypes: [...unmatched.values()].sort((a, b) => a.localeCompare(b)),
    }
}

/** What a template is fitted to on a data source with this schema, or null when
 *  it declares no entity types. Levels walk containment from the roots — the
 *  spine the wizard's other "one layer per…" gestures follow. */
export function fitTargetOf(schema: {
    entityTypes: readonly HierarchyPreviewEntityType[]
    relationshipTypes?: readonly HierarchyPreviewRelationship[]
    rootEntityTypes?: readonly string[]
    containmentEdgeTypes?: readonly string[]
}): FitTarget | null {
    if (schema.entityTypes.length === 0) return null
    const levels = buildHierarchyLevels(
        [...schema.entityTypes], [...(schema.relationshipTypes ?? [])],
        [...(schema.rootEntityTypes ?? [])], [...(schema.containmentEdgeTypes ?? [])],
    )
    return { types: schema.entityTypes, levels: levels.map(level => level.types.map(t => t.id)) }
}

/** What a fitted template's columns will hold, in the data's own words — each
 *  filled layer's types by plural name — and how many layers are left to fill by
 *  hand. Null when the data's types are not known: there is nothing to say. */
export function fitOutcome(fit: TemplateFit, target: FitTarget | null): { filled: string[]; byHand: number } | null {
    if (!target || target.types.length === 0) return null
    const label = new Map(target.types.map(t => [t.id, t.pluralName || t.name || t.id]))
    const filled = fit.layers.filter(l => l.entityTypes.length > 0)
        .map(l => l.entityTypes.map(t => label.get(t) ?? t).join(' + '))
    const byHand = fit.layers.filter(l => l.entityTypes.length === 0 && !(l.rules ?? []).some(hasCriteria)).length
    return { filled, byHand }
}

/**
 * A template's layers exactly as a new view gets them: fitted, with the
 * description and the colour the view fills in where the template has none.
 * One definition for the wizard and for matching a template's later versions
 * to the view (`templateUpdate.ts`, which knows the data's type ids only: what
 * the wizard filled by level or by a type's name is, to an update, the view's
 * own choice — kept).
 */
export function fitForView(layers: readonly ViewLayerConfig[], data: FitTarget | readonly string[] | null): TemplateFit {
    const fit = fitTemplate(layers, data)
    return {
        ...fit,
        layers: fit.layers.map((l, i) => ({
            ...l,
            description: l.description ?? '',
            color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
        })),
    }
}

export function layersForView(layers: readonly ViewLayerConfig[], data: FitTarget | readonly string[] | null): ViewLayerConfig[] {
    return fitForView(layers, data).layers
}
