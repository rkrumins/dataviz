/**
 * UnifiedPicker — what the user typed is the value.
 *
 * The reported failure: typing "74" into a property's VALUE field while the
 * suggestions held int64 samples that CONTAIN "74". Enter committed the first
 * sample, and clicking away committed nothing at all — the field still showed
 * "74" while the predicate underneath was `contains ""`, which matches every
 * node carrying the key. These tests pin the fixed contract: typed text leads
 * the list and wins Enter, Tab and click-away keep it, Escape drops it, and
 * the suggestions remain one ArrowDown away.
 */
import React, { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { UnifiedPicker } from '../UnifiedPicker'


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


const SAMPLES = ['-3746471915534727923', '-4274918641463862057', 'other']

function Single({ onChange, allowFreeText }: { onChange: (v: string) => void; allowFreeText?: boolean }) {
    const [value, setValue] = useState('')
    return (
        <>
            <UnifiedPicker
                options={SAMPLES}
                value={value}
                allowFreeText={allowFreeText}
                onChange={(v) => { setValue(v); onChange(v) }}
                placeholder="pick or type a value..."
            />
            <button type="button">elsewhere</button>
        </>
    )
}

function Multi({ onChange }: { onChange: (v: string[]) => void }) {
    const [value, setValue] = useState<string[]>([])
    return (
        <UnifiedPicker
            multiple
            options={SAMPLES}
            value={value}
            onChange={(v) => { setValue(v); onChange(v) }}
            placeholder="values"
        />
    )
}


describe('UnifiedPicker typed text', () => {
    it('Enter commits exactly what was typed, not the first sample that contains it', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74{Enter}')
        expect(onChange).toHaveBeenLastCalledWith('74')
    })

    it('offers the typed text first and the samples after it', async () => {
        render(<Single onChange={vi.fn()} />)
        await userEvent.type(screen.getByRole('combobox'), '74')
        const rows = screen.getAllByRole('option')
        expect(rows[0]).toHaveTextContent('Use “74”')
        expect(rows.slice(1).map((r) => r.textContent)).toEqual(SAMPLES.slice(0, 2))
    })

    it('ArrowDown then Enter still picks a sample', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74{ArrowDown}{Enter}')
        expect(onChange).toHaveBeenLastCalledWith(SAMPLES[0])
    })

    it('clicking away keeps the typed text', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74')
        await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }))
        expect(onChange).toHaveBeenLastCalledWith('74')
    })

    it('Tab keeps the typed text', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74{Tab}')
        expect(onChange).toHaveBeenLastCalledWith('74')
    })

    it('Escape drops the typed text', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74{Escape}')
        await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }))
        expect(onChange).not.toHaveBeenCalled()
    })

    it('an exact option match needs no extra row', async () => {
        render(<Single onChange={vi.fn()} />)
        await userEvent.type(screen.getByRole('combobox'), 'other')
        const rows = screen.getAllByRole('option')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toHaveTextContent('other')
    })

    it('without free text, Enter picks the highlighted suggestion', async () => {
        const onChange = vi.fn()
        render(<Single onChange={onChange} allowFreeText={false} />)
        await userEvent.type(screen.getByRole('combobox'), '74{Enter}')
        expect(onChange).toHaveBeenLastCalledWith(SAMPLES[0])
    })
})


describe('UnifiedPicker multi-select', () => {
    it('a pasted list becomes one chip per value', async () => {
        const onChange = vi.fn()
        render(<Multi onChange={onChange} />)
        const input = screen.getByRole('combobox')
        await userEvent.click(input)
        await userEvent.paste('alpha\nbeta, gamma\talpha')
        expect(onChange).toHaveBeenLastCalledWith(['alpha', 'beta', 'gamma'])
    })

    it('Enter adds the typed value as a chip', async () => {
        const onChange = vi.fn()
        render(<Multi onChange={onChange} />)
        await userEvent.type(screen.getByRole('combobox'), '74{Enter}')
        expect(onChange).toHaveBeenLastCalledWith(['74'])
    })
})
