/**
 * The Properties tab's Entities | Relationships switch: the view's entities' properties first, the
 * relationships' between them a click (or an arrow key) away — offered on that tab only.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { PropertyBrowserProps } from '../PropertyBrowser'

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/components/ui/DynamicIcon', () => ({ DynamicIcon: ({ name }: { name: string }) => <span data-icon={name} /> }))
vi.mock('../PropertyBrowser', () => ({
    PropertyBrowser: ({ subject = 'entities' }: PropertyBrowserProps) => <div data-testid="browser">{subject}</div>,
}))

import { PropertyManagerDrawer } from '../PropertyManagerDrawer'


describe('PropertyManagerDrawer — whose properties', () => {
    it('lists the entities’ properties first, and the relationships’ once switched to', async () => {
        const user = userEvent.setup()
        render(<PropertyManagerDrawer viewId="view-1" open onClose={vi.fn()} />)
        expect(screen.queryByRole('radiogroup', { name: 'Whose properties' })).toBeNull()

        await user.click(screen.getByRole('button', { name: 'Properties' }))
        const whose = within(screen.getByRole('radiogroup', { name: 'Whose properties' }))
        expect(whose.getByRole('radio', { name: 'Entities' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByTestId('browser')).toHaveTextContent('entities')

        await user.click(whose.getByRole('radio', { name: 'Relationships' }))
        expect(whose.getByRole('radio', { name: 'Relationships' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByTestId('browser')).toHaveTextContent('relationships')

        // From the keyboard too; and the choice holds while the rules are looked at.
        await user.keyboard('{ArrowLeft}')
        expect(screen.getByTestId('browser')).toHaveTextContent('entities')
        await user.keyboard('{ArrowRight}')
        await user.click(screen.getByRole('button', { name: 'Display rules' }))
        await user.click(screen.getByRole('button', { name: 'Properties' }))
        expect(screen.getByTestId('browser')).toHaveTextContent('relationships')
    })
})
