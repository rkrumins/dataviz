/**
 * A graph's health in its settings drawer, while an update is in flight: the panel opens with it
 * (its phase, sentence, bar and figures, as the server reports them), and says the last update that
 * finished; with no update in flight, the panel shows none.
 */
import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { progressOf } from '@/harness/updateProgressFixtures'
import { GraphSettingsDrawer } from '../GraphSettingsDrawer'
import { GRAPH, HEALTH, WS } from '../__fixtures__/api'
import { json, mockApi, renderWithApi } from './helpers'

const renderDrawer = () =>
    renderWithApi(<GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open onOpenChange={() => {}} label="Sales lineage" />)

const panel = async () => within((await screen.findByRole('heading', { name: 'Health now' })).closest('section')!)

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never))
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

describe('GraphHealthPanel with an update in flight', () => {
    it('opens with the update: its phase, sentence, bar and figures', async () => {
        const progress = progressOf({ targetSeq: 214, targetVersion: 214, phase: 'building', etaSecs: 190 })
        mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({ ...HEALTH, progress }) : undefined))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText('Version 214 is being built beside: 63% written, about 3 min left')).toBeInTheDocument()
        expect(health.getByRole('progressbar', { name: 'Building beside progress' })).toHaveAttribute('aria-valuenow', '63')
        expect(health.getByText(/6,300 of 10,000 rows · 25 rows a second/)).toBeInTheDocument()
        // The last update that finished, beside it, as the server recorded it.
        expect(health.getByText(/for 18,400 rows/)).toBeInTheDocument()
    })

    it('shows no update while none is in flight', async () => {
        mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({ ...HEALTH, progress: null }) : undefined))
        renderDrawer()
        const health = await panel()
        expect(health.getByText('1 version behind')).toBeInTheDocument()
        expect(health.queryByRole('progressbar')).toBeNull()
    })
})
