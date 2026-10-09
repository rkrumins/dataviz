/**
 * The Help panel is where Admin → Branding says the support address is
 * surfaced. It wasn't — the field saved, and nothing ever read it.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { brand } = vi.hoisted(() => ({ brand: { supportEmail: '' } }))

vi.mock('@/store/branding', () => ({
    useBrand: () => ({ appName: 'Test', shortName: 'T', ...brand }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/components/docs/search/useDocsSearchIndex', () => ({
    useDocsSearchIndex: () => ({ ready: false, search: () => [] }),
}))
vi.mock('@/components/onboarding/GettingStarted', () => ({ GettingStarted: () => null }))

import { HelpPanel } from '../HelpPanel'
import { useHelpPanelStore } from '@/store/helpPanel'

function renderOpen() {
    useHelpPanelStore.setState({ open: true, intent: 'home' })
    return render(<MemoryRouter><HelpPanel /></MemoryRouter>)
}

describe('HelpPanel — contact support', () => {
    beforeEach(() => {
        brand.supportEmail = ''
    })

    it('offers the branded support address as a mailto link', async () => {
        brand.supportEmail = 'help@acme.example'
        renderOpen()

        const link = await screen.findByRole('link', { name: /Contact support/i })
        expect(link).toHaveAttribute('href', 'mailto:help@acme.example')
        expect(link).toHaveTextContent('help@acme.example')
    })

    it('is hidden when no support address is set', async () => {
        renderOpen()

        expect(await screen.findByRole('link', { name: /Browse the full user guide/i })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /Contact support/i })).not.toBeInTheDocument()
    })
})
