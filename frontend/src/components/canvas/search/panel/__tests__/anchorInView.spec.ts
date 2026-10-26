/**
 * followAnchor — an open menu is placed again on scroll, on resize and on
 * every frame, so it stays on an anchor that moves with no event of its
 * own (inside a popover being placed), and stops once closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { followAnchor } from '../anchorInView'


describe('followAnchor', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }) })
    afterEach(() => { vi.useRealTimers() })

    it('places now, every frame, and on any scroll or resize — until cleaned up', () => {
        const place = vi.fn()
        const stop = followAnchor(place)
        expect(place).toHaveBeenCalledTimes(1)

        vi.advanceTimersToNextFrame()
        vi.advanceTimersToNextFrame()
        expect(place).toHaveBeenCalledTimes(3)

        const box = document.createElement('div')
        document.body.appendChild(box)
        box.dispatchEvent(new Event('scroll'))       // doesn't bubble: heard while capturing
        window.dispatchEvent(new Event('resize'))
        expect(place).toHaveBeenCalledTimes(5)

        stop()
        vi.advanceTimersToNextFrame()
        box.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('resize'))
        expect(place).toHaveBeenCalledTimes(5)
        box.remove()
    })
})
