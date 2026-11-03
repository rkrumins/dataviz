/**
 * The right-click menu always fits the window: it opens below and to the right of
 * the pointer, flips above it or to its left where it would run off, and a menu
 * taller than the window sits at its top and scrolls — every item reachable.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CanvasContextMenu } from '../CanvasContextMenu'
import { placeMenu } from '../menuPlacement'

const VIEW = { width: 1200, height: 800 }
const MENU = { width: 220, height: 400 }

describe('placeMenu', () => {
    it('opens below and to the right of the pointer when it fits', () => {
        expect(placeMenu({ x: 100, y: 100 }, MENU, VIEW)).toEqual({ left: 100, top: 100, maxHeight: 784 })
    })

    it('flips above the pointer near the bottom of the window', () => {
        expect(placeMenu({ x: 100, y: 700 }, MENU, VIEW).top).toBe(300)
    })

    it('flips to the left of the pointer near the right edge', () => {
        expect(placeMenu({ x: 1100, y: 100 }, MENU, VIEW).left).toBe(880)
    })

    it('keeps a menu that fits neither below nor above inside the window', () => {
        expect(placeMenu({ x: 100, y: 400 }, { width: 220, height: 600 }, VIEW).top).toBe(192)
    })

    it('starts a menu taller than the window at its top, held to its height', () => {
        expect(placeMenu({ x: 100, y: 500 }, { width: 220, height: 1400 }, VIEW))
            .toEqual({ left: 100, top: 8, maxHeight: 784 })
    })
})

describe('CanvasContextMenu', () => {
    it('scrolls its items under the header, in the document body rather than the canvas', () => {
        render(
            <div data-testid="canvas" style={{ transform: 'scale(0.5)' }}>
                <CanvasContextMenu
                    isOpen
                    position={{ x: 10, y: 10 }}
                    target={{ type: 'node', id: 'n1' }}
                    onClose={() => {}}
                    onEditNode={() => {}}
                    onDeleteNode={() => {}}
                />
            </div>,
        )
        const item = screen.getByRole('button', { name: /View & Edit/ })
        expect(item.closest('.overflow-y-auto')).not.toBeNull()
        const menu = item.closest('.fixed')
        expect(menu?.parentElement).toBe(document.body)
        expect(screen.getByTestId('canvas').contains(menu)).toBe(false)
    })
})
