/**
 * Layout templates and the data a view reads.
 *
 * A template is a generic structure: named layers in an order, each with
 * optional type hints written for SOME semantic layer.
 *
 * APPLIED (`fitTemplate`, `layersForView`), it comes in as authored: every
 * layer, name, colour and rule, and the hints this data declares, in its own
 * spelling (case-folded, the way the canvas matches them). A hint it does not
 * declare is dropped, and a layer left with none is filled by hand. When the
 * data's types are not known — no ontology, an empty one, or a schema that could
 * not be read — the hints are kept as written.
 *
 * SUGGESTED (`suggestFills`), when the person asks, for the layers nothing fills
 * yet:
 *   • by name — a hint, or the layer's own name, names one of the data's types:
 *     its id, name or plural name, with case, separators and a plural ending
 *     ignored ("DATA_PRODUCTS" is "dataProduct");
 *   • by level — layers still without a suggestion take the data's hierarchy
 *     levels in order, coarsest first: only levels lying between those of the
 *     filled layers around them, each level once, and only in a hierarchy of two
 *     levels or more.
 * Never a type another layer already holds, and never a layer its rules or its
 * entity (`anchorUrn`) fill.
 *
 * Rules are fitted like layers, logical nodes at any depth included. A rule
 * whose every type is unknown here can never match anything, so it is dropped
 * rather than left to place nothing — or worse, to match every entity once its
 * type list empties; the view's save refuses such a rule anyway.
 *
 * Pure. Applied layers get fresh ids — the new view owns them — and remember the
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

/** The data a template meets: its entity types and, when known, its hierarchy —
 *  type ids per level, coarsest first. */
export interface FitTarget {
    types: readonly FitType[]
    levels?: readonly (readonly string[])[]
}

/** Types suggested for a layer, and how they were chosen. */
export interface LayerFill {
    types: string[]
    by: 'name' | 'level'
}

export interface TemplateFit {
    layers: ViewLayerConfig[]
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
 * `data` — the data's entity types (a target, or just their ids), or null when
 * they are not known: the hints are then kept exactly as the template has them.
 */
export function fitTemplate(layers: readonly ViewLayerConfig[], data: FitTarget | readonly string[] | null): TemplateFit {
    const target = targetOf(data)
    const byFold = target ? new Map(target.types.map(t => [caseFold(t.id), t.id])) : null

    const resolve = (types: readonly string[]): string[] => {
        if (!byFold) return [...types]
        const out: string[] = []
        for (const t of types) {
            const hit = byFold.get(caseFold(t))
            if (hit !== undefined && !out.includes(hit)) out.push(hit)
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

    return {
        layers: layers.map((layer, i): ViewLayerConfig => ({
            ...layer,
            id: generateId(),
            templateLayerId: layer.id,
            order: i,
            entityTypes: resolve(layer.entityTypes ?? []),
            ...(layer.rules && { rules: fitRules(layer.rules) }),
            ...(layer.logicalNodes && { logicalNodes: fitNodes(layer.logicalNodes) }),
        })),
    }
}

/** Nothing fills the layer yet: no types, no rule, no entity of its own. */
function isOpen(layer: ViewLayerConfig): boolean {
    return (layer.entityTypes ?? []).length === 0 && !(layer.rules ?? []).some(hasCriteria) && !layer.anchorUrn
}

/**
 * What could fill each open layer, by layer id (see the header). `hintsOf` gives
 * a layer's hints besides its name — the template's, which applying may have
 * dropped. Nothing is suggested when the data declares no types.
 */
export function suggestFills(
    layers: readonly ViewLayerConfig[],
    target: FitTarget | null,
    hintsOf: (layer: ViewLayerConfig) => readonly string[] = () => [],
): Record<string, LayerFill> {
    if (!target || target.types.length === 0) return {}
    const find = typeFinder(target.types)
    const held = new Set(layers.flatMap(l => [...(l.entityTypes ?? []), ...(l.rules ?? []).flatMap(r => r.entityTypes ?? [])]).map(caseFold))
    const out: Record<string, LayerFill> = {}

    for (const layer of layers) {
        if (!isOpen(layer)) continue
        const types: string[] = []
        for (const hint of [...hintsOf(layer), layer.name]) {
            const hit = find(hint)
            if (hit !== undefined && !held.has(caseFold(hit)) && !types.includes(hit)) types.push(hit)
        }
        if (types.length > 0) {
            out[layer.id] = { types, by: 'name' }
            types.forEach(t => held.add(caseFold(t)))
        }
    }

    const levels = target.levels ?? []
    if (levels.length < 2) return out
    const levelOf = new Map<string, number>()
    levels.forEach((level, i) => level.forEach(t => { if (!levelOf.has(caseFold(t))) levelOf.set(caseFold(t), i) }))
    const free = levels.map(level => level.filter(t => !held.has(caseFold(t))))

    let floor = -1
    let run: ViewLayerConfig[] = []
    const fillRun = (ceiling: number) => {
        const slots = free.flatMap((types, j) => (j > floor && j < ceiling && types.length > 0 ? [j] : []))
        run.slice(0, slots.length).forEach((layer, k) => { out[layer.id] = { types: [...free[slots[k]]], by: 'level' } })
        run = []
    }
    for (const layer of layers) {
        if (isOpen(layer) && !out[layer.id]) {
            run.push(layer)
            continue
        }
        const types = out[layer.id]?.types ?? layer.entityTypes ?? []
        const anchor = Math.min(...types.map(t => levelOf.get(caseFold(t)) ?? Infinity))
        if (Number.isFinite(anchor)) {
            fillRun(anchor)
            floor = Math.max(floor, anchor)
        }
    }
    fillRun(levels.length)
    return out
}

/** The data a template meets on a data source with this schema, or null when it
 *  declares no entity types. Levels walk containment from the roots — the spine
 *  the wizard's other "one layer per…" gestures follow. */
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

/**
 * A template's layers exactly as a new view gets them: fitted, with the
 * description and the colour the view fills in where the template has none.
 * One definition for the wizard and for matching a template's later versions
 * to the view (`templateUpdate.ts`).
 */
export function layersForView(layers: readonly ViewLayerConfig[], data: FitTarget | readonly string[] | null): ViewLayerConfig[] {
    return fitTemplate(layers, data).layers.map((l, i) => ({
        ...l,
        description: l.description ?? '',
        color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
    }))
}
