/**
 * The trust status and the sensitivity label, each in its own shape, and the tooltip that
 * keeps "Restricted" apart from the admin's restricted-publishing setting.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ClassificationBadge, TrustBadges, TrustStatusBadge } from './TrustBadges'

describe('TrustBadges', () => {
    it('names each status', () => {
        render(<>
            <TrustStatusBadge status="certified" />
            <TrustStatusBadge status="in_review" />
            <TrustStatusBadge status="deprecated" />
        </>)
        expect(screen.getByText('Certified')).toHaveAttribute('data-trust', 'certified')
        expect(screen.getByText('In review')).toBeInTheDocument()
        expect(screen.getByText('Deprecated')).toBeInTheDocument()
    })

    it('says that Restricted is a sensitivity label, not restricted publishing', async () => {
        render(<ClassificationBadge classification="restricted" />)
        await userEvent.hover(screen.getByText('Restricted'))
        expect(await screen.findByText(/not the admin’s “restricted publishing” setting/)).toBeInTheDocument()
    })

    it('renders nothing for a source with neither', () => {
        const { container } = render(<TrustBadges trustStatus={null} classification={null} />)
        expect(container).toBeEmptyDOMElement()
    })
})
