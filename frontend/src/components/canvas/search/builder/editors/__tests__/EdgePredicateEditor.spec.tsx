/**
 * A key an edge keeps in its JSON of user properties compares by equality
 * only — the server refuses any other operator on one — so the editor
 * offers only those for it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { EdgePropertyPredicate } from '@/types/search'

import { EdgePredicateEditor } from '../EdgePredicateEditor'
import type { EditorContext } from '../index'


const ctx: EditorContext = {
    keysByEntityType: {}, allKeys: [], knownEntityTypes: [], knownLayers: [], tagValues: [],
    getValueSamples: () => [], edgeTypes: ['FEEDS'], keysByEdgeType: { FEEDS: ['confidence', 'mode'] },
    getEdgeValueSamples: () => [], edgeKeyStoredAs: { confidence: 'native', mode: 'json' },
}

// The operator menu, which reads in words as on a property row.
const operators = () => [...screen.getByDisplayValue(/^is( at least)?$/).querySelectorAll('option')].map((o) => o.value)


describe('EdgePredicateEditor — where an edge keeps a property', () => {
    it('offers every operator for an edge’s own field', () => {
        render(<EdgePredicateEditor ctx={ctx} onChange={vi.fn()}
            value={{ kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.8 }} />)
        expect(operators()).toContain('between')
        expect(screen.getByDisplayValue('is at least')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Compare an edge property')).toBeInTheDocument()
    })

    it('offers equality only for a key kept in the JSON, and says why', () => {
        render(<EdgePredicateEditor ctx={ctx} onChange={vi.fn()}
            value={{ kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' }} />)
        expect(operators()).toEqual(['eq', 'neq', 'in', 'notIn'])
        expect(screen.getByText(/compared by equality/)).toBeInTheDocument()
    })

    it('turns an ordering into equality when the key moves into the JSON', () => {
        const onChange = vi.fn()
        render(<EdgePredicateEditor ctx={ctx} onChange={onChange}
            value={{ kind: 'edgeProperty', key: 'confidence', op: 'gt', value: 1 }} />)
        fireEvent.click(screen.getByLabelText('Toggle dropdown'))
        fireEvent.click(screen.getByRole('option', { name: 'mode' }))
        const last = onChange.mock.calls.at(-1)?.[0] as EdgePropertyPredicate | undefined
        expect(last).toMatchObject({ key: 'mode', op: 'eq' })
    })
})
