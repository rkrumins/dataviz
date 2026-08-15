import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SelectionCheckbox } from './SelectionCheckbox'

describe('SelectionCheckbox', () => {
    it('renders an accessible checkbox button and toggles on click', () => {
        const onToggle = vi.fn()
        render(
            <SelectionCheckbox
                selected={false}
                onToggle={onToggle}
                ariaLabel="Select Physical Lineage5"
            />,
        )
        const box = screen.getByRole('checkbox', { name: 'Select Physical Lineage5' })
        expect(box).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(box)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('shows mixed state when indeterminate', () => {
        render(
            <SelectionCheckbox
                selected={false}
                indeterminate
                onToggle={() => {}}
                ariaLabel="Select all failed sources"
            />,
        )
        expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed')
    })
})
