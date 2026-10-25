/**
 * RelationDiagram — a relationship drawn the way it reads, and said the same
 * way to a screen reader: what this entity does to which relatives, through
 * which edges and how far, the arrow pointing the way the edges run.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSchemaStore } from '@/store/schema'
import type { Predicate, RelatedPredicate } from '@/types/search'

import { RelationDiagram } from '../RelationDiagram'
import { farEndTypes } from '../relations'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })

describe('RelationDiagram', () => {
    const before = useSchemaStore.getState().schema
    beforeEach(() => {
        useSchemaStore.setState({ schema: {
            ...(before ?? {}),
            entityTypes: [
                { id: 'dataJob', name: 'Data job', pluralName: 'Data jobs' },
                { id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
                { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards' },
                { id: 'glossaryTerm', name: 'Glossary term', pluralName: 'Glossary terms' },
                { id: 'column', name: 'Column', pluralName: 'Columns' },
                { id: 'domain', name: 'Domain', pluralName: 'Domains' },
            ],
            relationshipTypes: [{ id: 'PRODUCES', name: 'Produces', sourceTypes: ['dataJob'],
                targetTypes: ['dataset'], visual: { strokeColor: '#16a34a' } }],
        } as unknown as typeof before })
    })
    afterEach(() => useSchemaStore.setState({ schema: before }))

    it.each<[string, RelatedPredicate, string]>([
        ['lineage forwards', { kind: 'related', axis: 'downstream', maxHops: 3, where: type('dashboard') },
            'This feeds at least one Dashboard, 1–3 steps'],
        ['lineage backwards', { kind: 'related', axis: 'upstream', where: type('dataset') },
            'This is fed by at least one Dataset, 1 step'],
        ['an edge type, incoming', { kind: 'related', axis: 'upstream', edgeTypes: ['PRODUCES'],
            where: type('dataJob') }, 'This has incoming Produces from at least one Data job, 1 step'],
        ['an edge type, outgoing', { kind: 'related', axis: 'downstream', edgeTypes: ['PRODUCES'],
            quantifier: 'all', where: type('dataset') }, 'This Produces only Datasets, 1 step'],
        ['any link, either way', { kind: 'related', axis: 'neighbor', edgeClass: 'links',
            where: type('glossaryTerm') }, 'This is linked to at least one Glossary term through any link, 1 step'],
        ['any link, outgoing', { kind: 'related', axis: 'downstream', edgeClass: 'links' },
            'This links to at least one entity, 1 step'],
        ['the hierarchy, none', { kind: 'related', axis: 'descendant', quantifier: 'none',
            where: type('column') }, 'This contains no Column, any depth'],
        ['the hierarchy, a count', { kind: 'related', axis: 'child', count: { op: 'gte', value: 3 },
            where: type('column') }, 'This directly contains at least 3 Columns'],
        ['a named container', { kind: 'related', axis: 'ancestor', maxHops: 2,
            where: { kind: 'is', refs: [{ path: ['Finance'] }] } }, 'This is inside Finance, 1–2 levels'],
        ['conditions without a type', { kind: 'related', axis: 'parent',
            where: { kind: 'hasProperty', key: 'owner', negate: false } },
            'This is directly inside at least one entity that matches'],
    ])('says %s', (_, value, said) => {
        render(<RelationDiagram value={value} />)
        expect(screen.getByRole('img')).toHaveAccessibleName(said)
    })

    it('draws the far end from its conditions, and the edge the way it runs', () => {
        const { container } = render(<RelationDiagram value={{ kind: 'related', axis: 'upstream',
            edgeTypes: ['PRODUCES'], where: type('dataJob') }} />)
        expect(screen.getByRole('img')).toHaveTextContent('This')
        expect(screen.getByRole('img')).toHaveTextContent('Produces')
        expect(screen.getByRole('img')).toHaveTextContent('Data job')
        expect(screen.getByRole('img')).toHaveTextContent('at least one')
        // One arrowhead, pointing at this entity: the job produces it.
        const heads = container.querySelectorAll('[data-arrowhead]')
        expect(heads).toHaveLength(1)
        expect(heads[0]).toHaveClass('rotate-180')
    })

    it('opens the steps, edges and direction from the edge', () => {
        const onEdit = vi.fn()
        const { container } = render(<RelationDiagram value={{ kind: 'related', axis: 'downstream' }}
                                                      onEdit={onEdit} />)
        fireEvent.click(container.querySelector('button')!)
        expect(onEdit).toHaveBeenCalled()
    })

    it('reads the types a relative must be off its conditions', () => {
        expect(farEndTypes(type('a', 'b'))).toEqual(['a', 'b'])
        expect(farEndTypes({ kind: 'group', op: 'and', children: [
            { kind: 'tag', op: 'hasAny', values: ['PII'] }, type('column')] })).toEqual(['column'])
        expect(farEndTypes({ kind: 'entityType', op: 'notIn', values: ['a'] })).toEqual([])
        expect(farEndTypes({ kind: 'group', op: 'or', children: [type('a')] })).toEqual([])
        expect(farEndTypes(undefined)).toEqual([])
    })
})
