/**
 * The form primitives: a Field names and describes its control and announces its error; numbers
 * step with the keyboard and the steppers and stop at their bounds; a quantity keeps its value in
 * base units whatever unit it shows; the switch moved without breaking its old import.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BYTE_UNITS, DURATION_UNITS } from '@/lib/units'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { Field } from '../Field'
import { useField } from '../fieldContext'
import { Input } from '../Input'
import { NumberInput } from '../NumberInput'
import { QuantityInput } from '../QuantityInput'
import { Select } from '../Select'
import { Switch } from '../Switch'

describe('Field', () => {
    it('names its control by the label and describes it by the help line', () => {
        render(<Field label="Workspace name" help="Shown in the switcher."><Input /></Field>)
        const box = screen.getByRole('textbox', { name: 'Workspace name' })
        expect(box).toHaveAccessibleDescription('Shown in the switcher.')
        expect(box).not.toHaveAttribute('aria-invalid')
    })

    it('says the control is invalid, points at the error, and announces it in a live region', () => {
        const { rerender } = render(<Field label="Name" help="Required."><Input /></Field>)
        const live = document.querySelector('[aria-live="polite"]')
        expect(live).toBeInTheDocument()
        expect(live).toBeEmptyDOMElement()
        rerender(<Field label="Name" help="Required." error="Enter a name"><Input /></Field>)
        const box = screen.getByRole('textbox', { name: 'Name' })
        expect(box).toHaveAttribute('aria-invalid', 'true')
        expect(box).toHaveAccessibleDescription('Required. Enter a name')
        expect(box).toHaveAccessibleErrorMessage('Enter a name')
        expect(live).toHaveTextContent('Enter a name')
    })

    it('names a group by aria-labelledby', () => {
        render(<Field label="Read mode" group><GroupProbe /></Field>)
        expect(screen.getByRole('radiogroup', { name: 'Read mode' })).toBeInTheDocument()
    })
})

function GroupProbe() {
    // A stand-in for a control that is a group: it reads the label's id the way ChoiceCards does.
    return <div role="radiogroup" aria-labelledby={useField()?.labelId} />
}

describe('NumberInput', () => {
    function Probe({ start = 50, onChange = vi.fn(), ...rest }: { start?: number | null; onChange?: (n: number | null) => void } & Partial<Parameters<typeof NumberInput>[0]>) {
        const [v, setV] = useState<number | null>(start)
        return (
            <Field label="Start mark">
                <NumberInput value={v} onChange={(n) => { setV(n); onChange(n) }} min={30} max={95} unit="%" name="Start mark" {...rest} />
            </Field>
        )
    }

    it('is a spinbutton named by its field, with its unit spoken', () => {
        render(<Probe />)
        const spin = screen.getByRole('spinbutton', { name: 'Start mark' })
        expect(spin).toHaveAttribute('aria-valuenow', '50')
        expect(spin).toHaveAttribute('aria-valuemin', '30')
        expect(spin).toHaveAttribute('aria-valuemax', '95')
        expect(spin).toHaveAttribute('aria-valuetext', '50 %')
    })

    it('steps with the arrows, ten at a time with Shift and Page Up, and stops at the bounds', () => {
        const onChange = vi.fn()
        render(<Probe onChange={onChange} />)
        const spin = screen.getByRole('spinbutton', { name: 'Start mark' })
        fireEvent.keyDown(spin, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith(51)
        fireEvent.keyDown(spin, { key: 'ArrowUp', shiftKey: true })
        expect(onChange).toHaveBeenLastCalledWith(61)
        fireEvent.keyDown(spin, { key: 'PageUp' })
        expect(onChange).toHaveBeenLastCalledWith(71)
        for (let i = 0; i < 3; i += 1) fireEvent.keyDown(spin, { key: 'PageUp' })
        expect(onChange).toHaveBeenLastCalledWith(95)
        expect(screen.getByRole('button', { name: 'Increase Start mark' })).toBeDisabled()
        fireEvent.keyDown(spin, { key: 'ArrowDown' })
        expect(onChange).toHaveBeenLastCalledWith(94)
    })

    it('reads separators as typed, never sends text that is not a number, and puts the value back on blur', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Probe start={1000} max={1_000_000} onChange={onChange} />)
        const spin = screen.getByRole('spinbutton', { name: 'Start mark' })
        expect(spin).toHaveValue('1,000')
        await user.clear(spin)
        await user.type(spin, '12,500')
        expect(onChange).toHaveBeenLastCalledWith(12500)
        onChange.mockClear()
        await user.clear(spin)
        await user.type(spin, 'abc')
        expect(onChange).not.toHaveBeenCalledWith(expect.anything())
        expect(spin).toHaveAttribute('aria-invalid', 'true')
        await user.tab()
        expect(spin).toHaveValue('12,500')
        expect(spin).not.toHaveAttribute('aria-invalid')
    })

    it('steps with the − and + buttons', async () => {
        const onChange = vi.fn()
        render(<Probe onChange={onChange} />)
        await userEvent.click(screen.getByRole('button', { name: 'Decrease Start mark' }))
        expect(onChange).toHaveBeenLastCalledWith(49)
    })
})

describe('QuantityInput', () => {
    it('shows bytes in the largest round unit, and keeps the value when the unit changes', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        function Probe() {
            const [v, setV] = useState<number | null>(13 * 1024 ** 3)
            return <QuantityInput name="Largest copy" value={v} onChange={(n) => { setV(n); onChange(n) }} units={BYTE_UNITS} />
        }
        render(<Probe />)
        const spin = screen.getByRole('spinbutton')
        expect(spin).toHaveValue('13')
        expect(spin).toHaveAttribute('aria-valuetext', '13 GB')
        await user.selectOptions(screen.getByRole('combobox', { name: 'Largest copy: unit' }), 'MB')
        expect(spin).toHaveValue('13,312')
        expect(onChange).not.toHaveBeenCalled()
        await user.clear(spin)
        await user.type(spin, '512')
        expect(onChange).toHaveBeenLastCalledWith(512 * 1024 ** 2)
    })

    it('with no value, shows the fallback in the chosen unit and steps from it', () => {
        const onChange = vi.fn()
        render(<QuantityInput name="Idle time" value={null} fallback={1800} onChange={onChange} units={DURATION_UNITS} />)
        const spin = screen.getByRole('spinbutton')
        expect(spin).toHaveValue('')
        expect(spin).toHaveAttribute('placeholder', '30')
        expect(screen.getByRole('combobox', { name: 'Idle time: unit' })).toHaveValue('min')
        fireEvent.keyDown(spin, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith(1860)
    })

    it('stores seconds from minutes and speaks the unit in full', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<QuantityInput name="Idle time" value={1800} onChange={onChange} units={DURATION_UNITS}
            unitNames={{ s: 'seconds', min: 'minutes', h: 'hours', d: 'days' }} />)
        const spin = screen.getByRole('spinbutton')
        expect(spin).toHaveValue('30')
        expect(spin).toHaveAttribute('aria-valuetext', '30 minutes')
        fireEvent.keyDown(spin, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith(1860)
        await user.clear(spin)
        expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('gives the unit picker its own id inside a Field', () => {
        render(<Field label="Idle time"><QuantityInput value={60} onChange={() => {}} units={DURATION_UNITS} name="Idle time" /></Field>)
        const spin = screen.getByRole('spinbutton', { name: 'Idle time' })
        const unit = screen.getByRole('combobox', { name: 'Idle time: unit' })
        expect(unit.id).not.toBe(spin.id)
    })
})

describe('Select', () => {
    it('is named by its field and reports the chosen value', async () => {
        const onChange = vi.fn()
        render(
            <Field label="Build method">
                <Select value="auto" onChange={onChange}
                    options={[{ value: 'auto', label: 'Copy if there is room' }, { value: 'reseed', label: 'Rebuild from the database' }]} />
            </Field>,
        )
        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Build method' }), 'reseed')
        expect(onChange).toHaveBeenCalledWith('reseed')
    })
})

describe('Switch', () => {
    it('is a switch named by its field that toggles', async () => {
        const onChange = vi.fn()
        render(<Field label="Unload graphs automatically" help="Off: nothing is unloaded."><Switch checked={false} onChange={onChange} /></Field>)
        const sw = screen.getByRole('switch', { name: 'Unload graphs automatically' })
        expect(sw).toHaveAttribute('aria-checked', 'false')
        expect(sw).toHaveAccessibleDescription('Off: nothing is unloaded.')
        await userEvent.click(sw)
        expect(onChange).toHaveBeenCalledWith(true)
    })

    it('is still importable from Admin → Features, where it used to live', () => {
        expect(ToggleSwitch).toBe(Switch)
    })
})
