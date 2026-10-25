/**
 * The panel's edge from the keyboard: a window splitter the arrows step,
 * further with Shift, that Home and End take to either end — and that
 * remembers where it was left.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, ResizeHandle } from '../ResizeHandle'


describe('ResizeHandle from the keyboard', () => {
    beforeEach(() => localStorage.clear())

    it('steps with the arrows, further with Shift, and goes to either end', () => {
        const onResize = vi.fn()
        render(<ResizeHandle width={480} onResize={onResize} />)
        const edge = screen.getByRole('separator', { name: 'Resize search panel' })
        expect(edge).toHaveAttribute('tabindex', '0')
        expect(edge).toHaveAttribute('aria-valuenow', '480')
        expect(edge).toHaveAttribute('aria-valuemin', String(PANEL_MIN_WIDTH))
        expect(edge).toHaveAttribute('aria-valuemax', String(PANEL_MAX_WIDTH))

        fireEvent.keyDown(edge, { key: 'ArrowRight' })
        expect(onResize).toHaveBeenLastCalledWith(496)
        fireEvent.keyDown(edge, { key: 'ArrowLeft', shiftKey: true })
        expect(onResize).toHaveBeenLastCalledWith(400)
        fireEvent.keyDown(edge, { key: 'End' })
        expect(onResize).toHaveBeenLastCalledWith(PANEL_MAX_WIDTH)
        expect(localStorage.getItem('advanced-search:panel-width')).toBe(String(PANEL_MAX_WIDTH))
        fireEvent.keyDown(edge, { key: 'Home' })
        expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN_WIDTH)
    })

    it('goes no further than either end', () => {
        const onResize = vi.fn()
        render(<ResizeHandle width={PANEL_MIN_WIDTH} onResize={onResize} />)
        fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft', shiftKey: true })
        expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN_WIDTH)
    })
})
