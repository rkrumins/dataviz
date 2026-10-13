/**
 * PunchcardGrid — colour is never the only channel.
 *
 * Every cell names its weekday, hour and count; the busiest slot is said in
 * words; and the hours are labelled UTC, because "14:00" means a different
 * moment to every reader in another time zone.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { PunchcardGrid } from '../PunchcardGrid'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const grid = () => Array.from({ length: 7 }, () => Array(24).fill(0))

describe('PunchcardGrid', () => {
    it('draws a week of hours, Monday first, every cell saying what it holds', () => {
        const g = grid()
        g[1][14] = 9
        const { container } = render(<PunchcardGrid grid={g} />)
        expect(screen.getAllByRole('rowheader').map((th) => th.textContent))
            .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
        expect(container.querySelectorAll('td')).toHaveLength(7 * 24)
        expect(container.querySelector('td[title="Tuesday 14:00–15:00 UTC: 9 events"]')).not.toBeNull()
    })

    it('names the busiest slot in words, in UTC', () => {
        const g = grid()
        g[4][9] = 3
        g[1][14] = 9
        render(<PunchcardGrid grid={g} unit="operations" />)
        expect(screen.getByText('Tuesday 14:00 UTC')).toBeInTheDocument()
        expect(screen.getByText(/9 operations/)).toBeInTheDocument()
        // The grid itself says which clock its hours are on.
        expect(screen.getAllByRole('columnheader')[0]).toHaveTextContent(/^UTC/)
    })

    it('says so when nothing happened, instead of drawing an empty heat', () => {
        render(<PunchcardGrid grid={grid()} />)
        expect(screen.getByText(/Nothing recorded in this range/)).toBeInTheDocument()
    })
})
