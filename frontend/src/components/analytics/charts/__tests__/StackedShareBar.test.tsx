/**
 * StackedShareBar — colour follows the class, when the page says which.
 *
 * Slots are handed out in order by default. A page that draws the same
 * classes on a second chart passes `slotOf`, and then a class keeps its
 * colour whatever order the slices arrive in.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { StackedShareBar } from '../StackedShareBar'
import { SERIES_LIGHT } from '../chartTheme'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

/** The swatch beside each label in the keyed list, as `rgb(...)`. */
function swatch(label: string): string {
    const row = screen.getByText(label).closest('li')!
    return (row.querySelector('span[aria-hidden]') as HTMLElement).style.backgroundColor
}

function rgb(hex: string): string {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

describe('StackedShareBar', () => {
    it('hands out slots in order by default', () => {
        render(<StackedShareBar slices={[{ key: 'b', count: 3 }, { key: 'a', count: 1 }]} />)
        expect(swatch('B')).toBe(rgb(SERIES_LIGHT[0]))
        expect(swatch('A')).toBe(rgb(SERIES_LIGHT[1]))
    })

    it('keeps each class in its own slot, whatever the order', () => {
        const slotOf = (key: string) => ({ a: 0, b: 1 } as Record<string, number>)[key]
        render(<StackedShareBar slices={[{ key: 'b', count: 3 }, { key: 'a', count: 1 }]} slotOf={slotOf} />)
        expect(swatch('A')).toBe(rgb(SERIES_LIGHT[0]))
        expect(swatch('B')).toBe(rgb(SERIES_LIGHT[1]))
    })

    it('draws a class with no slot as the residual', () => {
        render(
            <StackedShareBar
                slices={[{ key: 'a', count: 3 }, { key: 'rest', count: 1 }]}
                slotOf={(key) => (key === 'a' ? 2 : undefined)}
            />,
        )
        expect(swatch('A')).toBe(rgb(SERIES_LIGHT[2]))
        expect(swatch('Rest')).not.toBe(rgb(SERIES_LIGHT[0]))
        expect(SERIES_LIGHT.map(rgb)).not.toContain(swatch('Rest'))
    })
})
