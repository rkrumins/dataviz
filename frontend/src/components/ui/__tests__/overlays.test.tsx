/**
 * Dialog, ConfirmDialog and Drawer: each is a named modal that keeps focus inside it (Tab wraps
 * both ways), closes on Esc and puts focus back on what opened it, and holds open while something
 * it started is still running.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../Button'
import { ConfirmDialog, Dialog } from '../Dialog'
import { Drawer } from '../Drawer'

function WithTrigger({ children }: { children: (open: boolean, setOpen: (o: boolean) => void) => ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <Button onClick={() => setOpen(true)}>Open</Button>
            <Button>Behind</Button>
            {children(open, setOpen)}
        </>
    )
}

/** Tabs through `count` stops and asserts focus never leaves `container`. */
async function tabsStayInside(user: ReturnType<typeof userEvent.setup>, container: HTMLElement, count: number, shift = false) {
    for (let i = 0; i < count; i += 1) {
        await user.tab({ shift })
        expect(container).toContainElement(document.activeElement as HTMLElement)
    }
}

describe('Dialog', () => {
    it('is a named, described modal that traps focus, closes on Esc and returns focus', async () => {
        const user = userEvent.setup()
        render(
            <WithTrigger>
                {(open, setOpen) => (
                    <Dialog open={open} onOpenChange={setOpen} title="Review your changes" description="Nothing is saved yet."
                        footer={<><Button>Cancel</Button><Button variant="primary">Save</Button></>}>
                        <input aria-label="Reason" />
                    </Dialog>
                )}
            </WithTrigger>,
        )
        const trigger = screen.getByRole('button', { name: 'Open' })
        await user.click(trigger)
        const dialog = screen.getByRole('dialog', { name: 'Review your changes' })
        expect(dialog).toHaveAccessibleDescription('Nothing is saved yet.')
        expect(dialog).toContainElement(document.activeElement as HTMLElement)
        await tabsStayInside(user, dialog, 6)
        await tabsStayInside(user, dialog, 6, true)
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(trigger).toHaveFocus()
    })

    it('holds open while it is not dismissible', async () => {
        const user = userEvent.setup()
        const onOpenChange = vi.fn()
        render(<Dialog open onOpenChange={onOpenChange} title="Saving" dismissible={false}>Working…</Dialog>)
        await user.keyboard('{Escape}')
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    })
})

describe('ConfirmDialog', () => {
    it('runs the action, shows it running, and cancels', async () => {
        const user = userEvent.setup()
        let finish: () => void = () => {}
        const onConfirm = vi.fn(() => new Promise<void>((r) => { finish = r }))
        const onOpenChange = vi.fn()
        render(
            <ConfirmDialog open onOpenChange={onOpenChange} title="Discard 3 changes?" confirmLabel="Discard" tone="danger"
                onConfirm={onConfirm}>
                Your staged changes go back to the values in force.
            </ConfirmDialog>,
        )
        const dialog = screen.getByRole('dialog', { name: 'Discard 3 changes?' })
        expect(dialog).toHaveTextContent('Your staged changes go back to the values in force.')
        const confirm = within(dialog).getByRole('button', { name: 'Discard' })
        await user.click(confirm)
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(confirm).toHaveAttribute('aria-busy', 'true')
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
        finish()
        await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'))
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})

describe('Drawer', () => {
    it('is a named side sheet that traps focus and closes on Esc, returning focus', async () => {
        const user = userEvent.setup()
        render(
            <WithTrigger>
                {(open, setOpen) => (
                    <Drawer open={open} onOpenChange={setOpen} eyebrow="Graph" title="Sales lineage"
                        footer={<Button variant="primary">Review</Button>}>
                        <input aria-label="Search settings" />
                        <Button>Use recommended</Button>
                    </Drawer>
                )}
            </WithTrigger>,
        )
        const trigger = screen.getByRole('button', { name: 'Open' })
        await user.click(trigger)
        const sheet = screen.getByRole('dialog', { name: 'Sales lineage' })
        await tabsStayInside(user, sheet, 6)
        await tabsStayInside(user, sheet, 6, true)
        expect(screen.getByRole('button', { name: 'Behind', hidden: true })).not.toHaveFocus()
        await user.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(trigger).toHaveFocus()
    })
})
