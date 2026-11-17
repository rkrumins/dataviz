/**
 * The trail says where the value in force came from, in words as well as in looks: which level
 * won, which values it overrode, which a lock ignored, which level chose nothing, the platform's
 * lock and limits (each badge opening what it means), an exception, a deployment value that was
 * ignored, and a staged change.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { limitsWords, stepAt } from '../format'
import { ProvenanceTrail } from '../ProvenanceTrail'
import type { ResolvedValues, Scope, SettingValue } from '../types'

function trail(key: string, values: ResolvedValues, scope: Scope, staged?: SettingValue | null) {
    render(<ProvenanceTrail setting={S[key]} resolved={values[key]} scope={scope} staged={staged} />)
    return within(screen.getByRole('list', { name: `Where ${S[key].label} comes from` })).getAllByRole('listitem')
}

describe('ProvenanceTrail', () => {
    it('adjusted: the graph chose `beside`, earlier levels are overridden, and what is in force says so', () => {
        const [dflt, platform, workspace, graph, inForce] = trail('reads.mode', GRAPH_VALUES, 'graph')
        expect(dflt).toHaveTextContent(`Default${S['reads.mode'].choices.find((c) => c.id === 'latest')!.title} (Overridden)`)
        expect(platform).toHaveTextContent('Platform')
        expect(within(platform).getByText('Limits')).toBeInTheDocument()
        expect(workspace).toHaveTextContent('WorkspaceNot set')
        expect(graph).toHaveTextContent('Graph· here: this graphKeep serving, switch when ready (Chosen)')
        expect(inForce).toHaveTextContent('In forceKeep serving, update in place (adjusted from Keep serving, switch when ready)')
    })

    it('locked: the platform wins outright and the graph’s own value is ignored', () => {
        const items = trail('imports.replaceGuard', GRAPH_VALUES, 'graph')
        expect(items).toHaveLength(4)
        expect(within(items[1]).getByText('Locked')).toBeInTheDocument()
        expect(items[1]).toHaveTextContent('On (In force)')
        expect(items[3]).toHaveTextContent('Off (Ignored: locked)')
    })

    it('exception: a system admin’s value outside the limits is badged where it was set', () => {
        const items = trail('drafts.keepClosedDays', WORKSPACE_VALUES, 'workspace')
        expect(within(items[2]).getByText('Exception')).toBeInTheDocument()
        expect(items[2]).toHaveTextContent('Forever (In force)')
        expect(within(items[1]).getByText('Limits')).toBeInTheDocument()
    })

    it('invalid env: the default says the deployment’s value was ignored', () => {
        const [dflt] = trail('database.readTimeoutMs', PLATFORM_VALUES, 'platform')
        expect(dflt).toHaveTextContent('15 seconds (In force)Deployment value ignored')
    })

    it('a staged change shows at the level being edited', () => {
        const items = trail('imports.guardDeleteShare', GRAPH_VALUES, 'graph', 0.25)
        expect(items[3]).toHaveTextContent('30% (In force)Your change: 25%')
    })

    it('opens a badge’s explanation on a tap or Enter, and Esc hands focus back to it', async () => {
        const user = userEvent.setup()
        const [, platform] = trail('reads.mode', GRAPH_VALUES, 'graph')
        const limits = within(platform).getByRole('button', { name: 'Limits' })
        const words = `Workspaces and graphs may choose only within limits. ${limitsWords(S['reads.mode'], stepAt(GRAPH_VALUES['reads.mode'], 'platform')!.limits!)}.`

        await user.click(limits)
        expect(screen.getByRole('dialog', { name: 'Limits' })).toHaveTextContent(words)
        expect(limits).toHaveAttribute('aria-expanded', 'true')
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: 'Limits' })).not.toBeInTheDocument()
        expect(limits).toHaveFocus()

        await user.keyboard('{Enter}')
        expect(screen.getByRole('dialog', { name: 'Limits' })).toHaveTextContent(words)
    })

    it('a staged return to inheriting says so', () => {
        expect(trail('imports.guardDeleteShare', GRAPH_VALUES, 'graph', null)[3]).toHaveTextContent('Your change: Not set (inherit)')
    })
})
