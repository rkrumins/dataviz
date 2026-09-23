/**
 * The "Property value" row — what its value is sent as, and when it runs.
 *
 * Reported: a value row whose VALUE was still empty compiled to
 * `CONTAINS ''` and matched every node carrying the key; a typed 19-digit id
 * went through `Number()` and was sent as a different integer; `in` and
 * `between` had one scalar input, so they could not be used at all.
 */
import React, { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate, PropertyPredicate } from '@/types/search'

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

function Harness({ initial, samples, onChange }: {
    initial: PropertyPredicate
    samples: unknown[]
    onChange: (p: Predicate) => void
}) {
    const [value, setValue] = useState<Predicate>(initial)
    return (
        <ConditionRow
            value={value}
            discovery={{
                allKeys: ['sourceId'], keysByEntityType: {}, tagValues: [],
                getValueSamples: () => samples,
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
