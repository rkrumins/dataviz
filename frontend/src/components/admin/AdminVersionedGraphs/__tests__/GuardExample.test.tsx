/**
 * The replace guard's explainer wherever its setting is shown: the platform's settings, a
 * workspace's Versioned graphs tab and a graph's drawer, in the Business view, where each row asks
 * its question. No page has an import's dry run to try, so each tries an example replace, labelled
 * as one. Labels come from the registry's generated catalogue.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { GraphSettingsDrawer } from '../GraphSettingsDrawer'
import { WorkspaceVersionedGraphs } from '../WorkspaceVersionedGraphs'
import { GRAPH, WS } from '../__fixtures__/api'
import { allowMenus, mockApi, renderWithApi } from './helpers'

const GUARD = CATALOGUE.settings.find((s) => s.key === 'imports.guardDeleteShare')!

beforeAll(allowMenus)
beforeEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never)
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

/** Opens the guard row's guidance and finds its explainer, labelled as an example. */
async function theExample() {
    const row = within(await screen.findByRole('article', { name: GUARD.question }))
    await userEvent.click(row.getByRole('button', { name: 'How it works' }))
    const figure = await row.findByRole('figure', { name: 'What stops a mistaken replace' })
    expect(within(figure).getByText('Example')).toBeInTheDocument()
    expect(within(figure).getByText('An example replace: drag to try another.')).toBeInTheDocument()
    expect(figure).toHaveAccessibleDescription(/^An example replace of 8,000 rows into a graph of 10,000 items\./)
    return figure
}

describe('The replace guard’s explainer, in the Business view', () => {
    it('on the platform’s settings, where the platform’s limits stop the example', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs?tab=settings' })
        expect(await theExample()).toHaveTextContent('This replace would be stopped')
    })

    it('on a workspace’s Versioned graphs tab', async () => {
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: { [WS]: ['workspace:admin', 'workspace:datasource:read'] } }, permissionsStatus: 'ready' } as never)
        mockApi('workspace-admin')
        renderWithApi(<WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" />, { path: `/workspaces/${WS}?tab=versioned-graphs`, route: '/workspaces/:wsId' })
        await theExample()
    })

    it('in a graph’s drawer', async () => {
        mockApi('workspace-admin')
        renderWithApi(<GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open onOpenChange={() => {}} label="Sales lineage" />)
        await theExample()
    })
})
