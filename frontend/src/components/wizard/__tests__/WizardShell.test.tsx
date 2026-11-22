/**
 * WizardShell's opt-in keyboard behaviour (`onEscape`): Esc calls it, Tab stays inside the wizard,
 * and focus goes back to what opened it. Something opened over the wizard (its own confirm) has
 * the keyboard while it is open. A wizard without `onEscape` behaves as it always has.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { WizardShell, type WizardShellProps } from '../WizardShell'

const STEPS = [{ id: 'one', label: 'One', icon: null }, { id: 'two', label: 'Two', icon: null }]

function Host({ onEscape }: { onEscape?: () => void }) {
    const [open, setOpen] = useState(false)
    const props: WizardShellProps = {
        title: 'A wizard', submitLabel: 'Finish', currentStep: 'one', activeSteps: STEPS, currentStepIndex: 0,
        onStepClick: () => {}, onBack: () => {}, onNext: () => {}, onClose: () => setOpen(false), canProceed: true,
        isLastStep: false, isSubmitting: false, onSubmit: () => {},
        onEscape: onEscape && (() => { onEscape(); setOpen(false) }),
        children: <input aria-label="A field" />,
    }
    return (
        <MemoryRouter>
            <button type="button" onClick={() => setOpen(true)}>Open it</button>
            {open && <WizardShell {...props} />}
            <button type="button">After the wizard</button>
        </MemoryRouter>
    )
}

describe('WizardShell', () => {
    it('with onEscape: holds Tab inside, closes on Esc, and gives focus back to what opened it', async () => {
        const onEscape = vi.fn()
        render(<Host onEscape={onEscape} />)
        const opener = screen.getByRole('button', { name: 'Open it' })
        await userEvent.click(opener)
        const dialog = screen.getByRole('dialog', { name: 'A wizard' })
        expect(dialog).toHaveFocus()
        for (let i = 0; i < 8; i++) {
            await userEvent.tab()
            expect(dialog).toContainElement(document.activeElement as HTMLElement)
        }
        await userEvent.tab({ shift: true })
        expect(dialog).toContainElement(document.activeElement as HTMLElement)

        await userEvent.keyboard('{Escape}')
        expect(onEscape).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(opener).toHaveFocus()
    })

    it('leaves Esc to something opened over the wizard while it has the keyboard', async () => {
        const onEscape = vi.fn()
        render(<Host onEscape={onEscape} />)
        await userEvent.click(screen.getByRole('button', { name: 'Open it' }))
        // A confirm opened over it, outside the wizard's own panel, with focus in it.
        const over = document.createElement('button')
        over.textContent = 'Keep going'
        document.body.appendChild(over)
        over.focus()
        await userEvent.keyboard('{Escape}')
        expect(onEscape).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'A wizard' })).toBeInTheDocument()
        over.remove()
    })

    it('without onEscape: as before, Esc does nothing and Tab is not held', async () => {
        render(<Host />)
        await userEvent.click(screen.getByRole('button', { name: 'Open it' }))
        const dialog = screen.getByRole('dialog', { name: 'A wizard' })
        expect(dialog).toHaveFocus()
        await userEvent.keyboard('{Escape}')
        expect(dialog).toBeInTheDocument()
        let left = false
        for (let i = 0; i < 12 && !left; i++) {
            await userEvent.tab()
            left = !dialog.contains(document.activeElement)
        }
        expect(left).toBe(true)
    })
})
