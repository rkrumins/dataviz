/**
 * The "Property value" row — what its value is sent as, and when it runs.
 *
 * Reported: a value row whose VALUE was still empty compiled to
 * `CONTAINS ''` and matched every node carrying the key; a typed 19-digit id
 * went through `Number()` and was sent as a different integer; `in` and
 * `between` had one scalar input, so they could not be used at all.
 */
import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate, PropertyPredicate } from '@/types/search'

import type { ValueSuggester } from '../../builder/useDiscovery'
import { ConditionRow, isRowIncomplete } from '../ConditionRow'


vi.mock('framer-motion', () => {
    const cache = new Map<string, React.ComponentType<unknown>>()
    const passthrough = (tag: string) => {
        let cmp = cache.get(tag)
        if (!cmp) {
            cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
                function MotionStub(props, ref) {
                    return React.createElement(tag, { ...props, ref })
                },
            ) as unknown as React.ComponentType<unknown>
            cache.set(tag, cmp)
        }
        return cmp
    }
    return {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    }
})


const prop = (over: Partial<PropertyPredicate>): PropertyPredicate => ({
    kind: 'property', key: 'sourceId', op: 'eq', value: '', caseSensitive: false, ...over,
})

function Harness({ initial, samples, onChange, suggestValues }: {
    initial: PropertyPredicate
    samples: unknown[]
    onChange: (p: Predicate) => void
    suggestValues?: ValueSuggester
}) {
    const [value, setValue] = useState<Predicate>(initial)
    return (
        <ConditionRow
            value={value}
            discovery={{
                allKeys: ['sourceId'], keysByEntityType: {}, tagValues: [],
                getValueSamples: () => samples, suggestValues,
            }}
            knownEntityTypes={[]}
            activeEntityTypes={[]}
            discoveredLayers={[]}
            isRunning={false}
            onChange={(p) => { setValue(p); onChange(p) }}
            onRemove={vi.fn()}
            onOpenAdvanced={vi.fn()}
        />
    )
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as PropertyPredicate
// The key picker renders first, the value picker second.
const valueCombobox = () => screen.getAllByRole('combobox').at(-1)!


describe('property row completeness', () => {
    it('is not a filter until its value is there', () => {
        expect(isRowIncomplete(prop({ key: '' , value: 'x' }))).toBe(true)
        expect(isRowIncomplete(prop({ value: '' }))).toBe(true)
        expect(isRowIncomplete(prop({ value: '   ' }))).toBe(true)
        expect(isRowIncomplete(prop({ value: '74' }))).toBe(false)
        expect(isRowIncomplete(prop({ value: 0 }))).toBe(false)
        expect(isRowIncomplete(prop({ value: false }))).toBe(false)
    })

    it('needs one list item for in / notIn and both ends for between', () => {
        expect(isRowIncomplete(prop({ op: 'in', value: [] }))).toBe(true)
        expect(isRowIncomplete(prop({ op: 'notIn', value: ['a'] }))).toBe(false)
        expect(isRowIncomplete(prop({ op: 'between', value: ['1', ''] }))).toBe(true)
        expect(isRowIncomplete(prop({ op: 'between', value: ['1', '2'] }))).toBe(false)
    })
})


describe('property row values', () => {
    it('sends a typed 19-digit id as its exact digits', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={[]} onChange={onChange} />)
        await userEvent.type(screen.getByPlaceholderText('type a value…'), '-3746471915534727923')
        expect(last(onChange).value).toBe('-3746471915534727923')
    })

    it('keeps text as text unless every known value is a number', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={['A-1', 'B-2']} onChange={onChange} />)
        await userEvent.type(valueCombobox(), '007{Enter}')
        expect(last(onChange).value).toBe('007')
    })

    it('sends a number when the property holds numbers', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={[10, 20]} onChange={onChange} />)
        await userEvent.type(valueCombobox(), '15{Enter}')
        expect(last(onChange).value).toBe(15)
    })

    it('switching to in keeps the value as a one-item list', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ value: 'gold' })} samples={[]} onChange={onChange} />)
        await userEvent.click(screen.getByRole('button', { name: 'Property operator' }))
        await userEvent.click(await screen.findByRole('option', { name: /^is one of/i }))
        expect(last(onChange)).toMatchObject({ op: 'in', value: ['gold'] })
    })

    it('between takes both ends of a range', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ op: 'between', value: ['', ''] })} samples={[1, 99]} onChange={onChange} />)
        await userEvent.type(screen.getByLabelText('Range from'), '10')
        await userEvent.type(screen.getByLabelText('Range to'), '20')
        expect(last(onChange).value).toEqual([10, 20])
    })
})


describe('property row types', () => {
    it('compares as the type its values have, and stamps it', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={['15', '200']} onChange={onChange} />)
        expect(screen.getByRole('button', { name: 'Compare as' })).toHaveTextContent('Number')
        await userEvent.type(valueCombobox(), '15{Enter}')
        expect(last(onChange)).toMatchObject({ value: 15, valueType: 'number' })
    })

    it('switching the type re-reads the value', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ value: 15, valueType: 'number' })} samples={[10]} onChange={onChange} />)
        await userEvent.click(screen.getByRole('button', { name: 'Compare as' }))
        await userEvent.click(await screen.findByRole('option', { name: /^Text/ }))
        expect(last(onChange)).toMatchObject({ value: '15', valueType: 'string', op: 'eq' })
    })

    it('true / false is a toggle', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={[true, false]} onChange={onChange} />)
        await userEvent.click(screen.getByRole('radio', { name: 'False' }))
        expect(last(onChange)).toMatchObject({ value: false, valueType: 'boolean' })
    })

    it('a date property takes a date', () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={['2024-05-01']} onChange={onChange} />)
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2024-05-02' } })
        expect(last(onChange)).toMatchObject({ value: '2024-05-02', valueType: 'date' })
    })

    it('"within the last" takes an amount and a unit', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ op: 'withinLast', value: '', valueType: 'date' })}
            samples={['2024-05-01']} onChange={onChange} />)
        await userEvent.type(screen.getByLabelText('How many'), '30')
        expect(last(onChange)).toMatchObject({ op: 'withinLast', value: 'P30D' })
    })

    it('presence operators need no value and run at once', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ value: 'x' })} samples={[]} onChange={onChange} />)
        await userEvent.click(screen.getByRole('button', { name: 'Property operator' }))
        await userEvent.click(await screen.findByRole('option', { name: /^is not set/i }))
        expect(last(onChange)).toMatchObject({ op: 'isNotSet' })
        expect(last(onChange).value).toBeUndefined()
        expect(isRowIncomplete(last(onChange))).toBe(false)
        expect(screen.queryByPlaceholderText('type a value…')).toBeNull()
    })

    it('a negative operator offers to include entities without the key', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({ op: 'neq', value: 'a' })} samples={[]} onChange={onChange} />)
        await userEvent.click(screen.getByRole('checkbox', { name: /include entities without/i }))
        expect(last(onChange)).toMatchObject({ op: 'neq', includeMissing: true })
    })

    it('a value that is not of the type is not applied, and says why', async () => {
        const onChange = vi.fn()
        render(<Harness initial={prop({})} samples={[1, 2]} onChange={onChange} />)
        await userEvent.type(valueCombobox(), 'abc{Enter}')
        expect(await screen.findByText(/not applied yet — "abc" is not a number/i)).toBeInTheDocument()
        expect(isRowIncomplete(last(onChange))).toBe(true)
    })
})


describe('has-property row by name', () => {
    it('matches property names and previews which ones', async () => {
        const onChange = vi.fn()
        function NameHarness() {
            const [value, setValue] = useState<Predicate>({ kind: 'hasProperty', key: '', negate: false })
            return (
                <ConditionRow
                    value={value}
                    discovery={{
                        allKeys: ['owner', 'ownerTeam', 'dataOwner', 'tier'],
                        keysByEntityType: {}, tagValues: [], getValueSamples: () => [],
                    }}
                    knownEntityTypes={[]}
                    activeEntityTypes={[]}
                    discoveredLayers={[]}
                    isRunning={false}
                    onChange={(p) => { setValue(p); onChange(p) }}
                    onRemove={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />
            )
        }
        render(<NameHarness />)
        await userEvent.click(screen.getByRole('button', { name: 'Match property names' }))
        await userEvent.click(await screen.findByRole('option', { name: /^Name contains/ }))
        await userEvent.type(screen.getByPlaceholderText('e.g. owner'), 'own')
        expect(onChange).toHaveBeenLastCalledWith(
            { kind: 'hasProperty', key: 'own', negate: false, keyMatch: 'contains' })
        expect(screen.getByText(/Matches 3 known properties/)).toBeInTheDocument()
    })
})


describe('property row suggestions', () => {
    it('lists the most common values across the view, with counts, and asks again while typing', async () => {
        const suggestValues = vi.fn<ValueSuggester>(async (_key, q) => ({
            key: 'sourceId',
            values: q ? [{ value: 'gold-2', count: 3 }] : [{ value: 'gold', count: 12 }, { value: 'silver', count: 4 }],
            complete: true, truncated: false,
        }))
        render(<Harness initial={prop({})} samples={['sampled']} onChange={vi.fn()} suggestValues={suggestValues} />)
        await userEvent.click(valueCombobox())
        expect(await screen.findByRole('option', { name: /^gold/ })).toHaveTextContent('12')
        expect(screen.queryByRole('option', { name: /sampled/ })).toBeNull()
        await userEvent.type(valueCombobox(), 'go')
        await waitFor(() => expect(suggestValues).toHaveBeenLastCalledWith('sourceId', 'go'))
    })

    it('one number and its text are one suggestion', async () => {
        const suggestValues = vi.fn<ValueSuggester>(async () => ({
            key: 'sourceId', values: [{ value: 15, count: 2 }, { value: '15', count: 1 }],
            complete: true, truncated: false,
        }))
        render(<Harness initial={prop({})} samples={[]} onChange={vi.fn()} suggestValues={suggestValues} />)
        await userEvent.click(valueCombobox())
        const options = await screen.findAllByRole('option', { name: /^15/ })
        expect(options).toHaveLength(1)
        expect(options[0]).toHaveTextContent('3')
    })

    it('says so when the list comes from part of a large view', async () => {
        const suggestValues = vi.fn<ValueSuggester>(async () => ({
            key: 'sourceId', values: [{ value: 'x', count: 1 }], complete: false, truncated: true,
        }))
        render(<Harness initial={prop({})} samples={[]} onChange={vi.fn()} suggestValues={suggestValues} />)
        expect(await screen.findByText(/Values listed from part of this view/)).toBeInTheDocument()
    })
})
