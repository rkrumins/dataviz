/**
 * MetricInfo — a definition that opens on a tap, a click, Enter or Space, never on hover alone: a
 * small dialog named for what it defines, with what it is and, where they are given, how it is
 * worked out and why it matters. Its trigger is the ⓘ, or the thing being defined (a badge, a word).
 * Esc closes it and puts focus back on its trigger; inside an open drawer it lives in the drawer,
 * which makes the rest of the page inert, and Esc closes the definition, not the drawer.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { Drawer } from '@/components/ui/Drawer'
import { MetricInfo } from '../MetricInfo'
import { METRICS } from '../metricDefinitions'

const ACTIVE = METRICS.activeUsers
const STORE = CATALOGUE.glossary.find((t) => t.term === 'Graph store')!
/** A word's definition: what it is, and no "how". */
const WORD = { title: STORE.term, what: STORE.definition }

describe('MetricInfo', () => {
    it('opens on a click: a dialog named for the figure, with what, how and why', async () => {
        const user = userEvent.setup()
        render(<MetricInfo metric="activeUsers" />)
        const trigger = screen.getByRole('button', { name: `What does "${ACTIVE.title}" mean?` })
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        await user.click(trigger)
        const definition = screen.getByRole('dialog', { name: ACTIVE.title })
        expect(definition).toHaveTextContent(ACTIVE.what)
        expect(within(definition).getByText("How it's calculated")).toBeInTheDocument()
        expect(definition).toHaveTextContent(ACTIVE.how!)
        expect(within(definition).getByText('Why it matters')).toBeInTheDocument()
        expect(definition).toHaveTextContent(ACTIVE.why!)
        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        expect(trigger).toHaveAttribute('aria-controls', definition.id)
        // It takes focus, so a screen reader reads it.
        expect(definition).toHaveFocus()

        // A press outside closes it.
        await user.click(document.body)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('needs no "how": a word or a status explains itself without one', async () => {
        const user = userEvent.setup()
        render(<MetricInfo definition={WORD} />)
        await user.click(screen.getByRole('button', { name: `What does "${STORE.term}" mean?` }))
        const definition = screen.getByRole('dialog', { name: STORE.term })
        expect(definition).toHaveTextContent(STORE.definition)
        expect(within(definition).queryByText("How it's calculated")).not.toBeInTheDocument()
        expect(within(definition).queryByText('Why it matters')).not.toBeInTheDocument()
    })

    it('takes its children as the trigger, named by their words, and opens on Enter or Space', async () => {
        const user = userEvent.setup()
        render(<p>Reads come from the <MetricInfo definition={WORD} className="inline"><span>graph store</span></MetricInfo>.</p>)
        const trigger = screen.getByRole('button', { name: 'graph store' })
        expect(screen.queryByRole('button', { name: /What does/ })).not.toBeInTheDocument()

        await user.tab()
        expect(trigger).toHaveFocus()
        await user.keyboard('{Enter}')
        expect(screen.getByRole('dialog', { name: STORE.term })).toHaveTextContent(STORE.definition)
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        await user.keyboard(' ')
        expect(screen.getByRole('dialog', { name: STORE.term })).toBeInTheDocument()
    })

    it('puts focus back on its trigger when Esc or Tab closes it', async () => {
        const user = userEvent.setup()
        render(<><MetricInfo definition={WORD}><span>graph store</span></MetricInfo><button type="button">Next</button></>)
        const trigger = screen.getByRole('button', { name: 'graph store' })

        await user.click(trigger)
        expect(screen.getByRole('dialog', { name: STORE.term })).toHaveFocus()
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()

        // Nothing in it takes focus, so Tab hands focus back rather than leaving it at the end of the page.
        await user.click(trigger)
        await user.tab()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
    })

    it('inside an open drawer, opens in the drawer, and Esc closes the definition, not the drawer', async () => {
        const user = userEvent.setup()
        function InDrawer() {
            const [open, setOpen] = useState(true)
            return (
                <>
                    <Drawer open={open} onOpenChange={setOpen} title="Sales lineage">
                        <p>Its readers use the <MetricInfo definition={WORD}><span>graph store</span></MetricInfo>.</p>
                    </Drawer>
                    {!open && <p>Drawer closed</p>}
                </>
            )
        }
        render(<InDrawer />)
        const drawer = screen.getByRole('dialog', { name: 'Sales lineage' })
        const trigger = within(drawer).getByRole('button', { name: 'graph store' })

        await user.click(trigger)
        // In the drawer's own tree: the page outside it is inert, and a press there would close it.
        const definition = within(drawer).getByRole('dialog', { name: STORE.term })
        expect(definition).toHaveTextContent(STORE.definition)
        await user.click(definition)
        expect(within(drawer).getByRole('dialog', { name: STORE.term })).toBeInTheDocument()

        await user.keyboard('{Escape}')
        expect(within(drawer).queryByRole('dialog', { name: STORE.term })).not.toBeInTheDocument()
        expect(screen.getByRole('dialog', { name: 'Sales lineage' })).toBeInTheDocument()
        expect(screen.queryByText('Drawer closed')).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()

        // With the definition closed, Esc is the drawer's again.
        await user.keyboard('{Escape}')
        expect(await screen.findByText('Drawer closed')).toBeInTheDocument()
    })
})
