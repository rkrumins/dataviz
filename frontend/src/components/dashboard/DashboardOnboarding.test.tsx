/**
 * First-run setup follows the layout templates switch: with templates off, the
 * template step and its quick-start card go, and progress counts what is left.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardOnboarding } from './DashboardOnboarding'

const renderIt = (onBrowseTemplates?: () => void) => render(
    <DashboardOnboarding
        completedSteps={['workspace_created']}
        onCreateWorkspace={vi.fn()}
        onBrowseTemplates={onBrowseTemplates}
        onDismiss={vi.fn()}
    />,
)

describe('DashboardOnboarding', () => {
    it('offers templates while they are on', () => {
        const browse = vi.fn()
        renderIt(browse)
        expect(screen.getByText('1/3')).toBeTruthy()
        fireEvent.click(screen.getByText('Start from a Template'))
        expect(browse).toHaveBeenCalled()
        expect(screen.getByText('Start a view from a template')).toBeTruthy()
    })

    it('leaves templates out while an admin has them off', () => {
        renderIt()
        expect(screen.getByText('1/2')).toBeTruthy()
        expect(screen.queryByText('Start a view from a template')).toBeNull()
        expect(screen.queryByText('Start from a Template')).toBeNull()
        expect(screen.getByText('Import from a Provider')).toBeTruthy()
    })
})
