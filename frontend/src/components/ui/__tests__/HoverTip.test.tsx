/**
 * The `title` attribute was reported as "doesn't even come on half the time".
 *
 * It waits about a second, renders in OS chrome, and on a card that swaps in
 * hover controls the pointer often lands on something else before it fires.
 * These lock the behaviour that replaced it — including the parts a native
 * tooltip never had: keyboard focus, and surviving a card that clips its own
 * children.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { HoverTip } from '../HoverTip'

describe('HoverTip', () => {
    it('appears on hover and goes away again', async () => {
        const user = userEvent.setup()
        render(<HoverTip label="12 people opened this"><span>12</span></HoverTip>)

        expect(screen.queryByRole('tooltip')).toBeNull()
        await user.hover(screen.getByText('12'))
        expect(await screen.findByRole('tooltip'))
            .toHaveTextContent('12 people opened this')

        await user.unhover(screen.getByText('12'))
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    })

    it('appears on keyboard focus, with no delay to sit through', async () => {
        const user = userEvent.setup()
        render(
            <HoverTip label="Nobody has favourited this">
                <button type="button">0</button>
            </HoverTip>,
        )
        await user.tab()
        expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    })

    it('describes its trigger, so a screen reader reads the two together', async () => {
        const user = userEvent.setup()
        render(<HoverTip label="Opened 340 times"><span>340</span></HoverTip>)
        await user.hover(screen.getByText('340'))

        const tip = await screen.findByRole('tooltip')
        expect(screen.getByText('340').parentElement)
            .toHaveAttribute('aria-describedby', tip.id)
    })

    it('escapes the card that would clip it', async () => {
        // Explorer cards are `overflow-hidden` with their own stacking
        // context, so an absolutely positioned bubble is cut off by the very
        // card it belongs to. The portal is the fix, not a stylistic choice.
        const user = userEvent.setup()
        const { container } = render(
            <div style={{ overflow: 'hidden' }}>
                <HoverTip label="Escaped"><span>hit me</span></HoverTip>
            </div>,
        )
        await user.hover(screen.getByText('hit me'))

        const tip = await screen.findByRole('tooltip')
        expect(container.contains(tip)).toBe(false)
        expect(document.body.contains(tip)).toBe(true)
    })

    it('never sits between the cursor and its own trigger', async () => {
        const user = userEvent.setup()
        render(<HoverTip label="Inert"><span>x</span></HoverTip>)
        await user.hover(screen.getByText('x'))
        expect(await screen.findByRole('tooltip'))
            .toHaveClass('pointer-events-none')
    })

    it('carries a quieter detail line under the lead', async () => {
        const user = userEvent.setup()
        render(
            <HoverTip
                label="Discard this draft"
                detail="Everything in it goes — this cannot be undone"
            >
                <button type="button" aria-label="Discard draft">x</button>
            </HoverTip>,
        )
        await user.hover(screen.getByLabelText('Discard draft'))

        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('Discard this draft')
        expect(tip).toHaveTextContent('Everything in it goes')
    })

    it('shows a keyboard shortcut as a chip, not as prose in the sentence', async () => {
        const user = userEvent.setup()
        render(
            <HoverTip label="Undo the last change on the canvas" shortcut="⌘Z">
                <button type="button">Undo</button>
            </HoverTip>,
        )
        await user.hover(screen.getByText('Undo'))

        const tip = await screen.findByRole('tooltip')
        // A real <kbd>, so it is announced and styled as a key rather than
        // being glued onto the end of the sentence.
        expect(tip.querySelector('kbd')).toHaveTextContent('⌘Z')
        expect(tip).toHaveTextContent('Undo the last change on the canvas')
    })

    // TWO WIDTHS, ONE SYSTEM. Neighbouring tips that wrap to wildly different
    // shapes are half of what "the text is all over the place" means.
    it('gives a one-line control tip the narrow box and a data tip the wide one', async () => {
        const user = userEvent.setup()
        const { unmount } = render(
            <HoverTip label="Choose who can see this view"><span>a</span></HoverTip>,
        )
        await user.hover(screen.getByText('a'))
        const control = await screen.findByRole('tooltip')
        expect(control).toHaveAttribute('data-tip-width', 'control')
        const controlWidth = control.style.maxWidth
        unmount()

        render(
            <HoverTip label={<span><b>12 people</b><i>in the last 30 days</i></span>}>
                <span>b</span>
            </HoverTip>,
        )
        await user.hover(screen.getByText('b'))
        const data = await screen.findByRole('tooltip')
        expect(data).toHaveAttribute('data-tip-width', 'data')
        expect(parseInt(data.style.maxWidth, 10))
            .toBeGreaterThan(parseInt(controlWidth, 10))
    })

    it('lets a caller override the width it would have chosen', async () => {
        const user = userEvent.setup()
        render(
            <HoverTip label="A string that still wants the wide box" width="data">
                <span>c</span>
            </HoverTip>,
        )
        await user.hover(screen.getByText('c'))
        expect(await screen.findByRole('tooltip'))
            .toHaveAttribute('data-tip-width', 'data')
    })

    // Entrance only. A portaled node with an exit animation is exactly how this
    // app strands invisible click-blockers over the canvas.
    it('animates in and never out', async () => {
        const user = userEvent.setup()
        render(<HoverTip label="Rises out of its trigger"><span>d</span></HoverTip>)
        await user.hover(screen.getByText('d'))

        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveClass('animate-in')
        expect(tip.className).not.toContain('animate-out')
    })

    it('still explains a control that is greyed out', async () => {
        // The highest-value tip in the app is "why can I not press this?", and
        // it was the one that could never fire: a disabled button dispatches no
        // mouse events, and they do not bubble to a wrapper either.
        const user = userEvent.setup()
        render(
            <HoverTip label="Nothing has changed yet">
                <button type="button" disabled>Save changes</button>
            </HoverTip>,
        )
        await user.hover(screen.getByText('Save changes'))
        expect(await screen.findByRole('tooltip'))
            .toHaveTextContent('Nothing has changed yet')
    })
})
