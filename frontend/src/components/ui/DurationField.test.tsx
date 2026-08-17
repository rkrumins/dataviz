import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DurationField, formatDuration } from './DurationField'

const PRESETS = [30, 60, 300, 900, 3600]

describe('formatDuration', () => {
    it('uses the largest natural unit', () => {
        expect(formatDuration(30)).toBe('30s')
        expect(formatDuration(60)).toBe('1m')
        expect(formatDuration(300)).toBe('5m')
        expect(formatDuration(3600)).toBe('1h')
        expect(formatDuration(5400)).toBe('90m')
    })
})

describe('DurationField', () => {
    it('shows the effective default when nothing is overridden', () => {
        render(
            <DurationField
                value={null} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByText(/Using default \(1m\)/)).toBeInTheDocument()
    })

    it('says it is overridden, and offers a reset', async () => {
        const onChange = vi.fn()
        render(
            <DurationField
                value={45} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByText(/Overridden: 45s/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: /reset to default/i }))
        expect(onChange).toHaveBeenCalledWith(null)
    })

    it('says a chosen preset once, not three times in two units', async () => {
        // The row used to read `[1m] 60 · Overridden: 1m` — the same duration
        // three times, twice in seconds, so the last cell read as a fifth
        // preset in a different unit. In a control that exists so operators
        // never convert between minutes and seconds, that is the whole bug.
        render(
            <DurationField
                value={30} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByRole('button', { name: '30s' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByLabelText(/custom, seconds/i)).toHaveValue(null)
        expect(screen.queryByText(/Overridden/)).not.toBeInTheDocument()
        // The way back to the default is still offered — that is not redundant.
        expect(screen.getByRole('button', { name: /reset to default/i })).toBeInTheDocument()
    })

    it('keeps the digits while you type a number a preset happens to cover', async () => {
        // Hiding preset matches unconditionally emptied the box on the third
        // keystroke of "300", because 30 is a preset on the way past.
        const onChange = vi.fn()
        function Owner() {
            const [v, setV] = useState<number | null>(null)
            return (
                <DurationField
                    value={v} presets={PRESETS} defaultSecs={60}
                    label="Look for changes every"
                    onChange={(n) => { setV(n); onChange(n) }}
                />
            )
        }
        render(<Owner />)
        const box = screen.getByLabelText(/custom, seconds/i)

        await userEvent.type(box, '300')

        expect(box).toHaveValue(300)
        expect(onChange).toHaveBeenLastCalledWith(300)
    })

    it('emits seconds when a preset is chosen', async () => {
        const onChange = vi.fn()
        render(
            <DurationField
                value={null} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        await userEvent.click(screen.getByRole('button', { name: '5m' }))
        expect(onChange).toHaveBeenCalledWith(300)
    })

    it('emits the typed number from the free-text box', async () => {
        // Driven through a real owner: a multi-digit entry only accumulates if
        // the field is genuinely controlled, and every other test here drives
        // it by prop or preset, so nothing else would notice if it were not.
        const onChange = vi.fn()
        function Owner() {
            const [v, setV] = useState<number | null>(null)
            return (
                <DurationField
                    value={v} presets={PRESETS} defaultSecs={60}
                    label="Look for changes every"
                    onChange={(n) => { setV(n); onChange(n) }}
                />
            )
        }
        render(<Owner />)

        await userEvent.type(screen.getByLabelText(/custom, seconds/i), '45')
        expect(onChange).toHaveBeenLastCalledWith(45)
    })

    it('clearing the free-text box means "default", not zero', async () => {
        // The invariant the whole control rests on: null and 0 are different
        // answers, and an emptied box is the null one.
        const onChange = vi.fn()
        render(
            <DurationField
                value={45} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        await userEvent.clear(screen.getByLabelText(/custom, seconds/i))
        expect(onChange).toHaveBeenCalledWith(null)
    })

    it('distinguishes an explicit 0 from the default', () => {
        // The exact ambiguity in the old dialog: 0 in a field whose helper
        // said "leave blank for the default".
        render(
            <DurationField
                value={0} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={900} label="Minimum time between rebuilds"
            />,
        )
        expect(screen.getByText(/Overridden: 0s/)).toBeInTheDocument()
        expect(screen.queryByText(/Using default/)).not.toBeInTheDocument()
    })

    it('marks the active preset for assistive tech', () => {
        render(
            <DurationField
                value={300} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={60} label="Check every"
            />,
        )
        expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false')
    })
})
