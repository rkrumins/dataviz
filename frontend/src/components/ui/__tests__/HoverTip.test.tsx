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
})
