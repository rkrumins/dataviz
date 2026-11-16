/**
 * The trail says where the value in force came from, in words as well as in looks: which level
 * won, which values it overrode, which a lock ignored, which level chose nothing, the platform's
 * lock and limits, an exception, a deployment value that was ignored, and a staged change.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '../__fixtures__/resolved'
import { ProvenanceTrail } from '../ProvenanceTrail'
import type { ResolvedValues, Scope, SettingValue } from '../types'

function trail(key: string, values: ResolvedValues, scope: Scope, staged?: SettingValue | null) {
    render(<ProvenanceTrail setting={S[key]} resolved={values[key]} scope={scope} staged={staged} />)
    return within(screen.getByRole('list', { name: `Where ${S[key].label} comes from` })).getAllByRole('listitem')
}

describe('ProvenanceTrail', () => {
    it('adjusted: the graph chose Switch when ready, earlier levels are overridden, and what is in force says so', () => {
        const [dflt, platform, workspace, graph, inForce] = trail('reads.mode', GRAPH_VALUES, 'graph')
        expect(dflt).toHaveTextContent('DefaultAlways the latest (Overridden)')
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

    it('reads a badge’s explanation with it, and makes no tab stop of it', () => {
        const [, platform] = trail('reads.mode', GRAPH_VALUES, 'graph')
        const limits = within(platform).getByText('Limits').parentElement as HTMLElement
        expect(limits).toHaveTextContent(/^Limits: Workspaces and graphs may choose only within limits\./)
        expect(limits).not.toHaveAttribute('tabindex')
        expect(platform.querySelector('[tabindex]')).toBeNull()
    })

    it('a staged return to inheriting says so', () => {
        expect(trail('imports.guardDeleteShare', GRAPH_VALUES, 'graph', null)[3]).toHaveTextContent('Your change: Not set (inherit)')
    })
})
