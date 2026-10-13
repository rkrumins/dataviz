/**
 * PulseMatrix — colour is never the only channel.
 *
 * Every cell names its workspace, period and count; every row ends with its
 * total; an idle period reads as a gap rather than as the faintest colour.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { PulseMatrix } from '../PulseMatrix'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const days = (n: number) => Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10))

describe('PulseMatrix', () => {
    it('gives every workspace a row, every cell its count, and every row a total', () => {
        const { container } = render(
            <PulseMatrix
                buckets={days(3)}
                rows={[
                    { id: 'ws1', label: 'Finance', title: 'Finance', values: [4, 0, 2], total: 6 },
                    { id: 'ws2', label: 'Growth', title: 'Growth', values: [1, 1, 1], total: 3 },
                ]}
            />,
        )
        expect(screen.getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Finance', 'Growth'])
        const finance = container.querySelectorAll('tbody tr')[0]
        expect(finance.querySelector('td[title^="Finance"][title$=": 4 events"]')).not.toBeNull()
        expect(finance.lastElementChild).toHaveTextContent('6')
    })

    it('leaves an idle period uncoloured, so a quiet week shows as a gap', () => {
        const { container } = render(
            <PulseMatrix
                buckets={days(3)}
                rows={[{ id: 'ws1', label: 'Finance', title: 'Finance', values: [4, 0, 2], total: 6 }]}
            />,
        )
        const cells = [...container.querySelectorAll<HTMLElement>('tbody td[title]')]
        expect(cells.map((c) => !!c.style.backgroundColor)).toEqual([true, false, true])
    })

    it('labels every other column on a long window, keeping each date for a screen reader', () => {
        render(
            <PulseMatrix
                buckets={days(30)}
                rows={[{ id: 'ws1', label: 'Finance', title: 'Finance', values: Array(30).fill(1), total: 30 }]}
            />,
        )
        const headers = screen.getAllByRole('columnheader')
        // Workspace, thirty periods, Total.
        expect(headers).toHaveLength(32)
        expect(headers.slice(1, -1).filter((th) => th.querySelector('.sr-only')).length).toBeGreaterThan(0)
    })
})
