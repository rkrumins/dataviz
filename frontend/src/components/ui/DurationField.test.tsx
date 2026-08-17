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
                value={30} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByText(/Overridden: 30s/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: /reset to default/i }))
        expect(onChange).toHaveBeenCalledWith(null)
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
