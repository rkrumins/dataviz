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
import { describe, expect, it } from 'vitest'
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
