/**
 * The orientation row.
 *
 * Two things matter beyond it rendering four numbers.
 *
 * **"Live" has to mean what the sign-in page means.** The count mirrors
 * `list_public_providers` server-side — enabled AND published. A tile that
 * counted drafts would tell an operator their connection is reaching people
 * when it reaches nobody, which is the exact confusion the draft lifecycle
 * exists to prevent.
 *
 * **A tile that cannot be computed shows a dash, not a zero.** The failure
 * count needs `system:audit:read`, which `system:admin` does not imply. A
 * confident "0 failed sign-ins" to someone who simply cannot see the audit
 * log is worse than admitting we do not know.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SsoStatTiles, type SsoStats } from '../SsoStatTiles'

function stats(over: Partial<SsoStats> = {}): SsoStats {
    return { live: 2, drafts: 1, rules: 7, failures24h: 3, ...over }
}

/** The tile carrying a given label, so a count is read from its own card
 *  rather than from whichever "0" appears first in the DOM. */
function tile(label: RegExp) {
    return screen.getByText(label).closest('div')!.parentElement!
}

describe('stat tiles', () => {
    it('renders each count against its label', () => {
        render(<SsoStatTiles stats={stats()} />)
        expect(within(tile(/live connections/i)).getByText('2')).toBeInTheDocument()
        expect(within(tile(/drafts to rehearse/i)).getByText('1')).toBeInTheDocument()
        expect(within(tile(/access rules/i)).getByText('7')).toBeInTheDocument()
        expect(within(tile(/failed sign-ins/i)).getByText('3')).toBeInTheDocument()
    })

    it('shows a dash, not a zero, when the count is unknown', () => {
        render(<SsoStatTiles stats={stats({ failures24h: null })} />)
        expect(within(tile(/failed sign-ins/i)).getByText('—')).toBeInTheDocument()
        expect(within(tile(/failed sign-ins/i)).queryByText('0')).toBeNull()
    })

    it('still renders the other three when one is unknown', () => {
        // A failed audit read must not blank the row it sits in.
        render(<SsoStatTiles stats={stats({ failures24h: null })} />)
        expect(within(tile(/live connections/i)).getByText('2')).toBeInTheDocument()
        expect(within(tile(/access rules/i)).getByText('7')).toBeInTheDocument()
    })

    it('renders a genuine zero as zero', () => {
        render(<SsoStatTiles stats={stats({ failures24h: 0, drafts: 0 })} />)
        expect(within(tile(/failed sign-ins/i)).getByText('0')).toBeInTheDocument()
        expect(within(tile(/drafts to rehearse/i)).getByText('0')).toBeInTheDocument()
    })
})

describe('stat tiles as navigation', () => {
    it('reports which tile was pressed', async () => {
        const onSelect = vi.fn()
        render(<SsoStatTiles stats={stats()} onSelect={onSelect} />)
        await userEvent.click(screen.getByRole('button', { name: /drafts to rehearse/i }))
        expect(onSelect).toHaveBeenCalledWith('drafts')
    })

    it('says where a tile goes, not just what it counts', () => {
        render(<SsoStatTiles stats={stats()} onSelect={vi.fn()} />)
        // The count alone is not an accessible name for a control — a
        // screen reader user pressing it should know where they land.
        expect(screen.getByRole('button', { name: /open access mapping/i }))
            .toBeInTheDocument()
        expect(screen.getByRole('button', { name: /open diagnostics/i }))
            .toBeInTheDocument()
    })

    it('does not offer a filter that would show nothing', () => {
        // Zero drafts: pressing it would narrow the list to an empty set.
        render(<SsoStatTiles stats={stats({ drafts: 0 })} onSelect={vi.fn()} />)
        expect(screen.queryByRole('button', { name: /drafts to rehearse/i })).toBeNull()
        expect(screen.getByRole('button', { name: /live connections/i }))
            .toBeInTheDocument()
    })

    it('stays inert without a handler', () => {
        render(<SsoStatTiles stats={stats()} />)
        expect(screen.queryAllByRole('button')).toHaveLength(0)
    })
})
