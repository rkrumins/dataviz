/**
 * EdgeSetPicker — edge types picked by name: the ontology's, each with what
 * it connects, the ones this data source holds first, any the graph holds
 * that the ontology doesn't name, and — for a connection — never the
 * hierarchy's.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSchemaStore } from '@/store/schema'

import { EdgeSetPicker } from '../EdgeSetPicker'
import { RelationContext } from '../relationContext'


const before = useSchemaStore.getState().schema

function seed(extra: Array<{ id: string; name: string }> = []) {
    useSchemaStore.setState({ schema: {
        ...(before ?? {}),
        entityTypes: [{ id: 'dataJob', name: 'Data job' }, { id: 'dataset', name: 'Dataset' },
            { id: 'glossaryTerm', name: 'Glossary term' }],
        relationshipTypes: [
            { id: 'PRODUCES', name: 'Produces', sourceTypes: ['dataJob'], targetTypes: ['dataset'] },
            { id: 'DEFINED_BY', name: 'Defined by', sourceTypes: ['dataset'], targetTypes: ['glossaryTerm'] },
            { id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true },
            ...extra.map((t) => ({ ...t, sourceTypes: [], targetTypes: [] })),
        ],
        containmentEdgeTypes: ['CONTAINS'],
    } as unknown as typeof before })
}

function picker(value: string[], { links = false, seen = ['PRODUCES', 'feeds_raw'] } = {}) {
    const onChange = vi.fn()
    render(
        <RelationContext.Provider value={{ depth: 0, rule: false, edges: {
            edgeTypes: seen, keysByEdgeType: {}, getEdgeValueSamples: () => [] } }}>
            <EdgeSetPicker value={value} onChange={onChange} links={links} />
        </RelationContext.Provider>,
    )
    return onChange
}

const rows = () => within(screen.getByRole('group', { name: 'Edge types' })).getAllByRole('checkbox')
    .map((box) => box.closest('label')!.textContent)


describe('EdgeSetPicker', () => {
    beforeEach(() => seed())
    afterEach(() => useSchemaStore.setState({ schema: before }))

    it('lists what this data source holds first, each with what it connects', () => {
        picker([])
        expect(rows()).toEqual([
            'Feeds raw',
            'ProducesData job → Dataset',
            'Containsnone in this data source yet',
            'Defined byDataset → Glossary term · none in this data source yet',
        ])
    })

    it('leaves the hierarchy out of a connection', () => {
        picker([], { links: true })
        expect(rows().some((r) => r?.startsWith('Contains'))).toBe(false)
    })

    it('picks and unpicks a type, whatever case it was named in', async () => {
        const user = userEvent.setup()
        const onChange = picker(['produces'])
        expect(screen.getByRole('checkbox', { name: /Produces/ })).toBeChecked()
        await user.click(screen.getByRole('checkbox', { name: /Produces/ }))
        expect(onChange).toHaveBeenLastCalledWith([])
        await user.click(screen.getByRole('checkbox', { name: /Defined by/ }))
        expect(onChange).toHaveBeenLastCalledWith(['produces', 'DEFINED_BY'])
    })

    it('finds a type by name past a handful of them', async () => {
        seed(Array.from({ length: 8 }, (_, i) => ({ id: `T${i}`, name: `Type ${i}` })))
        picker([])
        await userEvent.setup().type(screen.getByLabelText('Find an edge type'), 'defined')
        expect(rows()).toEqual(['Defined byDataset → Glossary term · none in this data source yet'])
    })
})
