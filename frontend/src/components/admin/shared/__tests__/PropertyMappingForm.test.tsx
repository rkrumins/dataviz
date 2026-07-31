/**
 * PropertyMappingForm — the controls a user actually types into.
 *
 * These cases are all about the form not fighting the person using it: a
 * separator you can clear and retype, a container key that tolerates a space
 * mid-edit, and an "Add" that refuses to silently overwrite a row.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'

import { PropertyMappingForm } from '../PropertyMappingForm'
import {
    DEFAULT_PROPERTY_MAPPING,
    type PropertyMapping,
} from '@/services/propertyStorageService'

/** Controlled harness — the form owns no state, so the test has to. */
function Harness({ initial, onChange }: {
    initial?: PropertyMapping
    onChange?: (m: PropertyMapping) => void
}) {
    const [value, setValue] = useState<PropertyMapping>(initial ?? DEFAULT_PROPERTY_MAPPING)
    return (
        <PropertyMappingForm
            value={value}
            onChange={m => { setValue(m); onChange?.(m) }}
            collisions={[{ field: 'level', samples: ['tier-1'], suggested: 'source/level' }]}
        />
    )
}

describe('PropertyMappingForm', () => {
    it('lets the separator be cleared and retyped', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Harness onChange={onChange} />)

        const sep = screen.getByLabelText('Path separator character')
        await user.clear(sep)

        // The field must go empty on screen — otherwise there is no way to
        // replace a separator, only to prepend to it.
        expect(sep).toHaveValue('')
        // …but an empty separator is never committed: it would collapse every
        // nested path into one ambiguous key.
        expect(onChange.mock.calls.every(([m]) => m.separator !== '')).toBe(true)

        await user.type(sep, '.')
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ separator: '.' }),
        )
    })

    it('restores the committed separator when the field is left empty', async () => {
        const user = userEvent.setup()
        render(<Harness />)

        const sep = screen.getByLabelText('Path separator character')
        await user.clear(sep)
        await user.tab()

        expect(sep).toHaveValue('/')
    })

    it('keeps a space typed into the container key', async () => {
        const user = userEvent.setup()
        render(<Harness initial={{ ...DEFAULT_PROPERTY_MAPPING, containerKey: null }} />)

        const key = screen.getByLabelText('Property container key')
        await user.type(key, 'my key')

        // Trimming on every keystroke made the space impossible to type —
        // the character was accepted and immediately dropped.
        expect(key).toHaveValue('my key')
    })

    it('clears the container key from the field itself', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Harness onChange={onChange} />)

        await user.click(screen.getByLabelText('Clear the container key'))

        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ containerKey: null }),
        )
    })

    it('refuses to overwrite an existing remap and says why', async () => {
        const user = userEvent.setup()
        render(<Harness initial={{
            ...DEFAULT_PROPERTY_MAPPING,
            propertyOverrides: { level: 'keep/this/path' },
        }} />)

        await user.type(screen.getByLabelText('Field to remap'), 'level')
        await user.click(screen.getByRole('button', { name: /Add/ }))

        expect(screen.getByRole('alert')).toHaveTextContent(/already\s+remapped/i)
        // The path the user had already set survives.
        expect(screen.getByLabelText('Property path for level')).toHaveValue('keep/this/path')
    })

    it('adds a remap for a field that has none', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Harness onChange={onChange} />)

        await user.type(screen.getByLabelText('Field to remap'), 'owner')
        await user.click(screen.getByRole('button', { name: /Add/ }))

        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ propertyOverrides: { owner: 'source/owner' } }),
        )
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('defines its terms of art without a mouse', () => {
        render(<Harness />)

        // Every one of these is a phrase that appears nowhere else in the
        // product, so the form is the only place it can be explained.
        for (const term of [
            'the property container', 'the path separator',
            'showing other fields', 'a name collision',
        ]) {
            expect(screen.getByRole('button', { name: `What is ${term}?` }))
                .toBeInTheDocument()
        }
    })
})
