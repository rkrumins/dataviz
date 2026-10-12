/**
 * The contact affordance, and the two ways it can go wrong.
 *
 * It reads no feature flag on purpose — the server already decided against the
 * reader's own scope, and a client that re-checked would be a second opinion
 * on an answered question. So the component's whole contract is: render what
 * arrived, render nothing when nothing arrived, and do not hijack the row it
 * sits inside.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ContactLink } from '../ContactLink'

describe('ContactLink', () => {
    it('is a mailto link naming who it reaches', () => {
        render(<ContactLink email="ada@example.com" name="Ada Lovelace" />)
        const link = screen.getByRole('link', { name: /ada lovelace/i })
        expect(link).toHaveAttribute('href', 'mailto:ada@example.com')
        expect(link).toHaveTextContent('ada@example.com')
    })

    it('renders nothing when the server sent no address', () => {
        // The normal case: contact off, privacy strict, or a view the reader
        // may not see. Absence is the answer, not an empty slot.
        const { container } = render(<ContactLink email={undefined} name="Ada" />)
        expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing for an explicit null', () => {
        const { container } = render(<ContactLink email={null} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('does not trigger the row it sits inside', () => {
        // Leaderboard rows open a drill-in on click. Without stopPropagation,
        // emailing someone would also navigate away from the page you wanted
        // to email them about.
        const onRowClick = vi.fn()
        render(
            <div onClick={onRowClick}>
                <ContactLink email="ada@example.com" name="Ada Lovelace" />
            </div>,
        )
        fireEvent.click(screen.getByRole('link'))
        expect(onRowClick).not.toHaveBeenCalled()
    })

    it('falls back to the address when there is no name', () => {
        render(<ContactLink email="ada@example.com" />)
        expect(screen.getByRole('link', { name: /ada@example.com/i })).toBeInTheDocument()
    })
})
