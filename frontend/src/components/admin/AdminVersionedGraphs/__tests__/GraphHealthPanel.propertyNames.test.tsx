/**
 * A graph's property names in its health: the meter against FalkorDB's per-graph ceiling, with the
 * platform's budget marked; what happens near and at the budget, said in words; the keys kept as
 * values, named by whether items or relationships carry them; where the reading came from; and a
 * graph nothing has counted yet, never shown as zero.
 */
import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { GraphSettingsDrawer } from '../GraphSettingsDrawer'
import { GRAPH, HEALTH, WS } from '../__fixtures__/api'
import { json, mockApi, renderWithApi } from './helpers'

const renderDrawer = () =>
    renderWithApi(<GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open onOpenChange={() => {}} label="Sales lineage" />)

const panel = async () => within((await screen.findByRole('heading', { name: 'Health now' })).closest('section')!)

const names = (over: Record<string, unknown> = {}) => ({
    registered: 1_240, platform: 90, budget: 50_000, ceiling: 65_534,
    measuredAt: '2026-11-16T12:30:00+00:00', measuredBy: 'update', storedAsValues: { nodes: [], edges: [], count: 0 },
    state: 'ok', ...over,
})

const withNames = (propertyNames: unknown) =>
    mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({ ...HEALTH, propertyNames }) : undefined))

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never))
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

describe('GraphHealthPanel property names', () => {
    it('meters the names against the ceiling and marks the budget', async () => {
        withNames(names())
        renderDrawer()
        const health = await panel()
        const meter = await health.findByRole('meter')
        expect(meter).toHaveAttribute('aria-valuenow', '1240')
        expect(meter).toHaveAttribute('aria-valuemax', '65534')
        expect(health.getByTestId('property-name-budget-mark')).toBeInTheDocument()
        expect(health.getByText(/Items and relationships share these names, and none is ever freed/)).toBeInTheDocument()
        expect(health.getByText(/As its last update found/)).toBeInTheDocument()
        expect(health.queryByRole('status')).toBeNull()
    })

    it('says what happens near the budget, and names the keys kept as values', async () => {
        withNames(names({
            registered: 46_000, state: 'near_budget',
            storedAsValues: { nodes: ['rare'], edges: ['my prop', 'weight note'], count: 3 },
        }))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText(/Close to 50,000: property names added past it are kept as values/)).toBeInTheDocument()
        expect(health.getByText('3 property keys kept as values')).toBeInTheDocument()
        expect(health.getByText('On items:')).toBeInTheDocument()
        expect(health.getByText('On relationships:')).toBeInTheDocument()
        expect(health.getByText('my prop')).toBeInTheDocument()
    })

    it('says a graph at the budget keeps new names as values', async () => {
        withNames(names({ registered: 50_000, state: 'at_budget' }))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText(/At 50,000: new property names are kept as values/)).toBeInTheDocument()
    })

    it('reads a count from its data source, and names no keys then', async () => {
        withNames(names({ measuredBy: 'poll', storedAsValues: null }))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText(/As its data source was last counted/)).toBeInTheDocument()
        expect(health.queryByText(/kept as values/)).toBeNull()
    })

    it('never shows a graph nothing has counted as zero', async () => {
        withNames(names({ registered: null, platform: null, measuredAt: null, measuredBy: null, storedAsValues: null, state: 'unknown' }))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText('Property names not measured yet')).toBeInTheDocument()
        expect(health.getByText(/Counted at its next update/)).toBeInTheDocument()
        expect(health.queryByRole('meter')).toBeNull()
    })

    it('says why when it couldn’t be read', async () => {
        mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({
            ...HEALTH, propertyNames: null,
            problems: [{ part: 'propertyNames', message: 'How many property names it uses can’t be read right now.' }],
        }) : undefined))
        renderDrawer()
        const health = await panel()
        expect(await health.findByText('How many property names it uses can’t be read right now.')).toBeInTheDocument()
    })
})
