/**
 * The Property Manager's width: its left edge drags (or steps from the
 * keyboard) to the width the reader wants, which it keeps the next time it
 * opens, within the same bounds as the details panel. Until the reader
 * chooses, it keeps its own default.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DRAWER_MIN_WIDTH } from '@/components/panels/shell/drawerWidth'
import { usePreferencesStore } from '@/store/preferences'
import { useReferenceModelStore } from '@/store/referenceModelStore'

import { PropertyManagerDrawer } from '../PropertyManagerDrawer'


vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify: vi.fn() }),
}))

const renderDrawer = () => render(<PropertyManagerDrawer viewId="view-1" open onClose={vi.fn()} />)
const edge = () => screen.getByRole('separator', { name: 'Resize Property Manager' })
const body = () => document.querySelector<HTMLElement>('[data-panel="property-manager"] > div')!


beforeEach(() => {
    usePreferencesStore.setState({ propertyManagerWidth: null, drawerWidth: null })
    useReferenceModelStore.setState({ displayRules: [] })
})


describe('PropertyManagerDrawer — width', () => {
    it("keeps its default until the reader chooses one", () => {
        renderDrawer()
        // jsdom drops clamp() from inline styles; what matters is that no
        // width of the reader's is set.
        expect(body().style.width).not.toMatch(/px$/)
    })

    it('drags wider at its left edge, and keeps the width the next time it opens', () => {
        const { unmount } = renderDrawer()
        const start = Number(edge().getAttribute('aria-valuenow'))
        fireEvent.pointerDown(edge(), { clientX: 1000 })
        fireEvent.pointerMove(window, { clientX: 900 })
        fireEvent.pointerUp(window, { clientX: 900 })
        expect(usePreferencesStore.getState().propertyManagerWidth).toBe(start + 100)
        // Its own width: the details panel's is left alone.
        expect(usePreferencesStore.getState().drawerWidth).toBeNull()
        unmount()

        renderDrawer()
        expect(body()).toHaveStyle({ width: `${start + 100}px` })
    })

    it('steps from the keyboard, and goes no narrower than the details panel can', () => {
        usePreferencesStore.setState({ propertyManagerWidth: 560 })
        renderDrawer()
        expect(edge()).toHaveAttribute('aria-valuenow', '560')
        fireEvent.keyDown(edge(), { key: 'ArrowLeft' })
        expect(usePreferencesStore.getState().propertyManagerWidth).toBe(576)
        fireEvent.keyDown(edge(), { key: 'Home' })
        expect(usePreferencesStore.getState().propertyManagerWidth).toBe(DRAWER_MIN_WIDTH)
    })
})
