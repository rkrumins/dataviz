/**
 * PropertyManagerButton — the first-run "New — Property Manager" coachmark.
 *
 * It used to render as an absolutely positioned child of the header, whose
 * `backdrop-blur` makes a stacking context: everything below the header
 * band was painted over by the canvas, so users saw a permanent 15 px
 * strip peeking under the button and could never read or close it. The
 * coachmark now portals to the body, and it can be dismissed on its own.
 */
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PropertyManagerButton, PROPERTY_MANAGER_SEEN_KEY } from '../PropertyManagerButton'

const HINT = /New — Property Manager/

function mount(props: Partial<React.ComponentProps<typeof PropertyManagerButton>> = {}) {
    const onToggle = vi.fn()
    const utils = render(
        <div data-header>
            <PropertyManagerButton open={false} onToggle={onToggle} {...props} />
        </div>,
    )
    return { ...utils, onToggle, header: utils.container.querySelector('[data-header]')! }
}

describe('PropertyManagerButton first-run coachmark', () => {
    beforeEach(() => { localStorage.clear() })
    afterEach(() => { cleanup() })

    it('on first run the coachmark renders OUTSIDE the header, fixed to the viewport', () => {
        const { header } = mount()
        const hint = screen.getByText(HINT).closest('[role="status"]') as HTMLElement
        expect(hint).not.toBeNull()
        expect(header.contains(hint)).toBe(false)
        expect(document.body.contains(hint)).toBe(true)
        expect(hint.style.position).toBe('fixed')
    })

    it('is silent once the hint has been seen', () => {
        localStorage.setItem(PROPERTY_MANAGER_SEEN_KEY, '1')
        mount()
        expect(screen.queryByText(HINT)).toBeNull()
    })

    it('is silent while the manager is already open', () => {
        mount({ open: true })
        expect(screen.queryByText(HINT)).toBeNull()
    })

    it('"Got it" closes the hint on its own and never shows it again', async () => {
        const user = userEvent.setup()
        const { onToggle, unmount } = mount()
        await user.click(screen.getByRole('button', { name: 'Got it' }))
        expect(screen.queryByText(HINT)).toBeNull()
        expect(onToggle).not.toHaveBeenCalled()
        expect(localStorage.getItem(PROPERTY_MANAGER_SEEN_KEY)).toBe('1')
        unmount()
        mount()
        expect(screen.queryByText(HINT)).toBeNull()
    })

    it('opening the manager also closes the hint and marks it seen', async () => {
        const user = userEvent.setup()
        const { onToggle } = mount()
        await user.click(screen.getByRole('button', { name: /Properties/ }))
        expect(onToggle).toHaveBeenCalledTimes(1)
        expect(screen.queryByText(HINT)).toBeNull()
        expect(localStorage.getItem(PROPERTY_MANAGER_SEEN_KEY)).toBe('1')
    })
})
