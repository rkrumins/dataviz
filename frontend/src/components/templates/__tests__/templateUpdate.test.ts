/**
 * A template's new version, reaching a view built from an older one: what the
 * template changed and the view didn't is taken, what the view changed is kept,
 * both-changed is the person's call, and the view's own layers are never touched.
 */
import { describe, expect, it } from 'vitest'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { layersForView } from '../templateFit'
import {
    applyTemplateUpdate, defaultChoices, diffTemplateLayers, ORDER_KEY, planTemplateUpdate,
    type TemplateUpdateInput,
} from '../templateUpdate'

const L = (id: string, name: string, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
    ({ id, name, color: '#111111', entityTypes: ['Table'], order: 0, ...extra })

const BASE = [L('bronze', 'Bronze'), L('silver', 'Silver'), L('gold', 'Gold')]

/** The view the wizard made from `base`: its own ids, the template's in `templateLayerId`. */
function viewFrom(base: ViewLayerConfig[] = BASE, declared: string[] | null = null): ViewLayerConfig[] {
    return layersForView(base, declared).map(l => ({ ...l, id: `v-${l.templateLayerId}` }))
}

function input(
    latest: ViewLayerConfig[],
    layers: ViewLayerConfig[] = viewFrom(),
    assignments: Record<string, LayerAssignmentEntry> = {},
    { base = BASE, declared = null }: { base?: ViewLayerConfig[]; declared?: string[] | null } = {},
): TemplateUpdateInput {
    return { base, latest, view: { layers, assignments }, declared }
}

function run(i: TemplateUpdateInput, extra: string[] = []) {
    const plan = planTemplateUpdate(i)
    const take = new Set([...defaultChoices(plan), ...extra])
    let n = 0
    return { plan, ...applyTemplateUpdate(i, plan, take, () => `new-${++n}`) }
}

const names = (layers: ViewLayerConfig[]) => layers.map(l => l.name)
const at = (layers: ViewLayerConfig[], id: string) => layers.find(l => l.id === id)!
const placed = (layerId: string, logicalNodeId?: string): LayerAssignmentEntry =>
    ({ layerId, inheritsChildren: true, ...(logicalNodeId && { logicalNodeId }) })

describe('planTemplateUpdate', () => {
    it('finds nothing when the template did not change', () => {
        expect(planTemplateUpdate(input(BASE))).toEqual({ follows: true, rows: [], order: null })
    })

    it('takes what only the template changed', () => {
        const { plan, layers } = run(input([L('bronze', 'Raw'), BASE[1], BASE[2]]))
        expect(plan.rows).toMatchObject([{ kind: 'changed', viewLayerId: 'v-bronze', fields: [{ field: 'name', conflict: false }] }])
        expect(names(layers)).toEqual(['Raw', 'Silver', 'Gold'])
    })

    it("keeps what only the view changed, even while taking the template's other changes", () => {
        const view = viewFrom()
        view[1] = { ...view[1], color: '#ff0000' }
        const { plan, layers } = run(input([BASE[0], L('silver', 'Cleaned'), BASE[2]], view))
        expect(plan.rows).toHaveLength(1)
        expect(at(layers, 'v-silver')).toMatchObject({ name: 'Cleaned', color: '#ff0000' })
    })

    it('has nothing to say when both made the same change', () => {
        const view = viewFrom()
        view[2] = { ...view[2], name: 'Curated' }
        expect(planTemplateUpdate(input([BASE[0], BASE[1], L('gold', 'Curated')], view)).rows).toEqual([])
    })

    it("leaves a both-changed field to the person, keeping the view's by default", () => {
        const view = viewFrom()
        view[2] = { ...view[2], name: 'Curated' }
        const i = input([BASE[0], BASE[1], L('gold', 'Gold+')], view)
        const { plan, layers } = run(i)
        expect(plan.rows).toMatchObject([{ kind: 'changed', fields: [{ key: 'gold:name', conflict: true, ours: 'Curated', theirs: 'Gold+' }] }])
        expect(at(layers, 'v-gold').name).toBe('Curated')
        expect(at(run(i, ['gold:name']).layers, 'v-gold').name).toBe('Gold+')
    })

    it("speaks the view's semantic layer: its spelling, and types it lacks are no change", () => {
        const declared = ['table']
        const view = viewFrom(BASE, declared)
        expect(view[0].entityTypes).toEqual(['table'])
        const latest = [L('bronze', 'Bronze', { entityTypes: ['Table', 'Report'] }), BASE[1], BASE[2]]
        expect(planTemplateUpdate(input(latest, view, {}, { declared })).rows).toEqual([])
    })

    it("puts a new layer beside its template neighbours, the view's own layers staying put", () => {
        const view = [...viewFrom(), L('mine', 'Mine')].map(l => ({ ...l, scopeEdges: { edgeTypes: ['CONTAINS'] } as never }))
        const latest = [...BASE, L('platinum', 'Platinum')]
        const { plan, layers } = run(input(latest, view))
        expect(plan.rows).toMatchObject([{ kind: 'added', key: 'platinum' }])
        expect(names(layers)).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum', 'Mine'])
        const added = layers[3]
        expect(added).toMatchObject({ id: 'new-1', templateLayerId: 'platinum', scopeEdges: { edgeTypes: ['CONTAINS'] } })
        expect(layers.map(l => l.order)).toEqual([0, 1, 2, 3, 4])
    })

    it('drops a layer the template dropped, when the view neither placed nor edited anything in it', () => {
        const { plan, layers } = run(input([BASE[0], BASE[2]]))
        expect(plan.rows).toMatchObject([{ kind: 'removed', key: 'silver', conflict: false }])
        expect(names(layers)).toEqual(['Bronze', 'Gold'])
    })

    it('keeps a dropped layer the view placed entities in, unless the person chooses', () => {
        const assignments = { 'urn:a': placed('v-silver'), 'urn:b': placed('v-gold') }
        const i = input([BASE[0], BASE[2]], viewFrom(), assignments)
        const kept = run(i)
        expect(kept.plan.rows).toMatchObject([{ kind: 'removed', placed: 1, conflict: true }])
        expect(names(kept.layers)).toEqual(['Bronze', 'Silver', 'Gold'])
        const removed = run(i, ['silver'])
        expect(names(removed.layers)).toEqual(['Bronze', 'Gold'])
        expect(removed.assignments).toEqual({ 'urn:b': placed('v-gold') })
    })

    it('keeps a dropped layer the view edited', () => {
        const view = viewFrom()
        view[1] = { ...view[1], description: 'Our cleaned tables' }
        expect(planTemplateUpdate(input([BASE[0], BASE[2]], view)).rows)
            .toMatchObject([{ kind: 'removed', edited: true, conflict: true }])
    })

    it('respects a layer the view deleted, offering it back only when the template changed it', () => {
        const without = viewFrom().filter(l => l.id !== 'v-silver')
        expect(planTemplateUpdate(input(BASE, without)).rows).toEqual([])
        const i = input([BASE[0], L('silver', 'Silver v2'), BASE[2]], without)
        const kept = run(i)
        expect(kept.plan.rows).toMatchObject([{ kind: 'restorable', key: 'silver' }])
        expect(names(kept.layers)).toEqual(['Bronze', 'Gold'])
        expect(names(run(i, ['silver']).layers)).toEqual(['Bronze', 'Silver v2', 'Gold'])
    })

    it("adopts the template's new order in its own slots", () => {
        const [bronze, silver, gold] = viewFrom()
        const view = [bronze, L('mine', 'Mine'), silver, gold]
        const { plan, layers } = run(input([BASE[2], BASE[1], BASE[0]], view))
        expect(plan.order).toEqual({ conflict: false })
        expect(names(layers)).toEqual(['Gold', 'Mine', 'Silver', 'Bronze'])
    })

    it('keeps the view order when both reordered differently', () => {
        const [bronze, silver, gold] = viewFrom()
        const i = input([BASE[2], BASE[0], BASE[1]], [silver, bronze, gold])
        const { plan, layers } = run(i)
        expect(plan.order).toEqual({ conflict: true })
        expect(names(layers)).toEqual(['Silver', 'Bronze', 'Gold'])
        expect(names(run(i, [ORDER_KEY]).layers)).toEqual(['Gold', 'Bronze', 'Silver'])
    })

    it("lets go of placements in a group the template's new groups no longer have", () => {
        const groups = [{ id: 'g1', name: 'One', type: 'group' as const }, { id: 'g2', name: 'Two', type: 'group' as const }]
        const base = [L('bronze', 'Bronze', { logicalNodes: groups }), BASE[1], BASE[2]]
        const latest = [L('bronze', 'Bronze', { logicalNodes: [groups[0]] }), BASE[1], BASE[2]]
        const assignments = { 'urn:1': placed('v-bronze', 'g1'), 'urn:2': placed('v-bronze', 'g2') }
        const { assignments: after } = run(input(latest, viewFrom(base), assignments, { base }))
        expect(after).toEqual({ 'urn:1': placed('v-bronze', 'g1'), 'urn:2': placed('v-bronze') })
    })

    it("treats copies and the view's own layers as the view's, and says when nothing follows the template", () => {
        const view = [...viewFrom(), { ...viewFrom()[0], id: 'copy' }, L('mine', 'Mine')]
        const { layers } = run(input([L('bronze', 'Raw'), BASE[1], BASE[2]], view))
        expect(names(layers)).toEqual(['Raw', 'Silver', 'Gold', 'Bronze', 'Mine'])
        expect(planTemplateUpdate(input([L('bronze', 'Raw')], [L('mine', 'Mine')])).follows).toBe(false)
    })

    it('does not mistake empty for changed', () => {
        const view = viewFrom().map(l => ({ ...l, description: '' }))
        const latest = BASE.map(l => ({ ...l, description: undefined, rules: [] }))
        expect(planTemplateUpdate(input(latest, view)).rows).toEqual([])
    })

    it('finds nothing more to do once applied, and never changes what it was given', () => {
        const view = Object.freeze(viewFrom().map(l => Object.freeze(l))) as ViewLayerConfig[]
        const latest = [L('bronze', 'Raw'), BASE[2], L('platinum', 'Platinum')]
        const first = run(input(latest, view, Object.freeze({}) as never))
        const again = planTemplateUpdate({ base: latest, latest, view: { layers: first.layers, assignments: first.assignments }, declared: null })
        expect(again.rows).toEqual([])
        expect(again.order).toBeNull()
        expect(names(view)).toEqual(['Bronze', 'Silver', 'Gold'])
    })
})

describe('diffTemplateLayers', () => {
    it('lists what was added, removed and changed between two versions', () => {
        expect(diffTemplateLayers(BASE, [L('bronze', 'Raw'), BASE[2], L('platinum', 'Platinum')])).toEqual([
            { kind: 'changed', id: 'bronze', name: 'Raw', fields: ['name'] },
            { kind: 'added', id: 'platinum', name: 'Platinum', fields: [] },
            { kind: 'removed', id: 'silver', name: 'Silver', fields: [] },
        ])
    })
})
