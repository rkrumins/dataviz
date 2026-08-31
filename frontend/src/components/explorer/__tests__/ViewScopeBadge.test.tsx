/**
 * ViewScopeBadge — three pills that now say WHAT they are, not just what they
 * are called.
 *
 * The reported shape: an Explorer card showed "Major Refactor Agg",
 * "Perf-Load-Test-Solidatus" and "Falkor Docker" in a row, three colours, three
 * proper nouns, and nothing on screen saying which was a workspace, which a
 * data source and which the database serving it. The only help was a native
 * `title` that repeated the name the reader had just read.
 *
 * This component reaches Explorer cards, list rows, the hero, the recent strip
 * and the preview drawer, so what it says is what five surfaces say.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ViewScopeBadge } from '../ViewScopeBadge'

const FULL = {
    workspaceId: 'ws-1',
    workspaceName: 'Major Refactor Agg',
    dataSourceId: 'ds-1',
    dataSourceName: 'Perf-Load-Test-Solidatus',
    providerName: 'Falkor Docker',
    providerType: 'FalkorDB',
}

describe('ViewScopeBadge — each pill names its layer', () => {
    it('says a workspace is a workspace, and what belonging to it decides', async () => {
        const user = userEvent.setup()
        render(<ViewScopeBadge {...FULL} />)
        await user.hover(screen.getByText('Major Refactor Agg'))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('Workspace · Major Refactor Agg')
        expect(tip).toHaveTextContent(/who can find and open it is decided here/i)
    })

    it('says a data source is where the view draws from', async () => {
        const user = userEvent.setup()
        render(<ViewScopeBadge {...FULL} />)
        await user.hover(screen.getByText('Perf-Load-Test-Solidatus'))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('Data source · Perf-Load-Test-Solidatus')
        expect(tip).toHaveTextContent(/drawn from Perf-Load-Test-Solidatus/i)
    })

    it('says a provider is the database serving the view, and names the engine', async () => {
        const user = userEvent.setup()
        render(<ViewScopeBadge {...FULL} />)
        await user.hover(screen.getByText('Falkor Docker'))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('Graph provider · Falkor Docker')
        expect(tip).toHaveTextContent('FalkorDB')
    })

    it('does not claim an engine it was never given', async () => {
        const user = userEvent.setup()
        render(<ViewScopeBadge {...FULL} providerType={null} />)
        await user.hover(screen.getByText('Falkor Docker'))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent(/the graph database serving this view/i)
        expect(tip).not.toHaveTextContent('FalkorDB')
    })

    it('explains the unnamed workspace a non-member sees, instead of repeating the placeholder', async () => {
        // A non-member gets no name for the workspace — the pill has always
        // said "Workspace" rather than leak a raw UUID, and the old `title`
        // then said "Workspace" a second time. The tip now says why.
        const user = userEvent.setup()
        render(<ViewScopeBadge workspaceId="ws-9" workspaceName={null} />)
        await user.hover(screen.getByText('Workspace'))
        expect(await screen.findByRole('tooltip'))
            .toHaveTextContent(/you are not a member, so its name is not shown/i)
    })

    it('drops the pill entirely when the surface is already one workspace', () => {
        render(<ViewScopeBadge {...FULL} hideWorkspace />)
        expect(screen.queryByText('Major Refactor Agg')).toBeNull()
        expect(screen.getByText('Perf-Load-Test-Solidatus')).toBeInTheDocument()
    })

    it('renders only the pills it has facts for', () => {
        render(<ViewScopeBadge workspaceId="ws-1" workspaceName="Writes" />)
        expect(screen.getByText('Writes')).toBeInTheDocument()
        expect(screen.queryByText(/data source/i)).toBeNull()
    })

    it('carries a fill that actually compiles, on both tinted pills', () => {
        // The regression: these were authored `bg-emerald-500/8` and
        // `bg-sky-500/8`, and 8 is not on Tailwind's opacity scale — an
        // off-scale modifier emits NO rule, so both pills shipped with no fill
        // at all on five surfaces while the workspace pill beside them was
        // properly tinted. The compile-level guard is
        // `src/__tests__/noDeadAlphaOnCssVarTokens.test.ts`, which now scans
        // stock palette colours for exactly this; this pins the notation here
        // so the bracket form cannot be "tidied" back to a bare number.
        const { container } = render(<ViewScopeBadge {...FULL} />)
        const classes = [...container.querySelectorAll('span')]
            .flatMap(el => [...el.classList])
        expect(classes).toContain('bg-emerald-500/[0.08]')
        expect(classes).toContain('bg-sky-500/[0.08]')
        // Tailwind's opacity scale is MULTIPLES OF FIVE, so `/15` on the
        // workspace pill is fine and `/8` was not. Ban only the off-scale
        // shape, or this would fail on a perfectly good tint.
        const offScale = classes.filter((c) => {
            const m = /\/(\d{1,3})$/.exec(c)
            return m !== null && Number(m[1]) % 5 !== 0
        })
        expect(offScale, 'an off-scale modifier compiles to no rule at all').toEqual([])
    })
})
