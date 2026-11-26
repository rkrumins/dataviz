/**
 * PropertyBrowser over the relationships between the view's entities (subject `relationships`):
 * every property they carry, read from the view's relationship catalog — counted per relationship
 * type, each coloured as the canvas draws it, with relationship words everywhere; found with or
 * without a property, or with a value, by a Connections search; and changed in bulk through the one
 * dialog, on the relationships holding the property — or, from New, every one in the view. Its
 * loading, stale, empty, refused and failed states say so in their own words.
 */
import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import type { EntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import type { CatalogSubject, SearchCatalogProperty, SearchCatalogResult } from '@/types/search'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'
import { useSchemaStore } from '@/store/schema'

import { PropertyBrowser } from '../PropertyBrowser'


const notify = vi.fn()
let relationships: PropertyCatalogState
let entities: PropertyCatalogState
let editing: EntityEditing
let canEditLayer = false
const asked: Array<[string, CatalogSubject]> = []

vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: (viewId: string, subject: CatalogSubject = 'entities') => {
        asked.push([viewId, subject])
        return subject === 'relationships' ? relationships : entities
    },
}))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
    useEntityEditing: () => editing,
}))
vi.mock('@/features/ontology/lib/useSemanticLayerAccess', () => ({
    useSemanticLayerAccess: () => ({ canEdit: canEditLayer }),
}))
vi.mock('../PromoteFieldDialog', () => ({
    PromoteFieldDialog: () => <div role="dialog" aria-label="An entity type's field" />,
    PromoteRelationshipFieldDialog: ({ propertyKey, types, kinds }: { propertyKey: string; types: object; kinds: object }) => (
        <div role="dialog" aria-label={`Make ${propertyKey} a field`}>{JSON.stringify({ types, kinds })}</div>
    ),
}))


function property(over: Partial<SearchCatalogProperty> & { key: string }): SearchCatalogProperty {
    return { count: 0, distinct: 0, distinctExact: true, byEntityType: {}, kinds: {}, values: [], residual: 0, ...over }
}

const SLA = property({
    key: 'sla', count: 9300, byEntityType: { PRODUCES: 6200, TRANSFORMS: 3100 }, kinds: { String: 9300 }, distinct: 3, residual: 40,
    values: [
        { value: '4h', kind: 'String', count: 6000 }, { value: '4H', kind: 'String', count: 300 }, { value: '1d', kind: 'String', count: 3000 },
    ],
})
const RETRIES = property({
    key: 'retries', count: 1200, byEntityType: { TRANSFORMS: 1200 }, kinds: { Integer: 1100, String: 100 }, distinct: 4, min: 0, max: 9,
    values: [{ value: 3, kind: 'Integer', count: 900 }, { value: 0, kind: 'Integer', count: 200 }, { value: '3', kind: 'String', count: 100 }],
})

function catalog(over: Partial<SearchCatalogResult> = {}): SearchCatalogResult {
    return {
        sessionId: 's', subject: 'relationships', status: 'complete', stale: false, entities: 31_200,
        asOf: new Date().toISOString(),
        entityTypes: [{ type: 'PRODUCES', count: 20_000 }, { type: 'TRANSFORMS', count: 9200 }, { type: 'CONTAINS', count: 2000 }],
        properties: [SLA, RETRIES], tags: [], tagged: null,
        ...over,
    }
}

const state = (over: Partial<PropertyCatalogState> = {}): PropertyCatalogState => ({
    catalog: catalog(), reading: null, error: null, unavailable: false, refresh: vi.fn(), ...over,
})

const queryClient = new QueryClient()
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

function renderBrowser(over: Partial<PropertyCatalogState> = {}, props: Partial<Parameters<typeof PropertyBrowser>[0]> = {}) {
    relationships = state(over)
    const onSearchPredicate = vi.fn()
    const onCreateRuleFromPredicate = vi.fn()
    render(
        <PropertyBrowser viewId="view-1" subject="relationships" onSearchPredicate={onSearchPredicate}
            onCreateRuleFromPredicate={onCreateRuleFromPredicate} {...props} />,
        { wrapper },
    )
    return { onSearchPredicate, onCreateRuleFromPredicate }
}

const card = (key: string) => screen.getByTitle(key).closest('.group') as HTMLElement

async function openMenu(user: ReturnType<typeof userEvent.setup>, key: string) {
    await user.click(within(card(key)).getByRole('button', { name: `More actions for ${key}` }))
    return within(await screen.findByRole('menu'))
}

const take = () => usePropertyJobsStore.getState().consumeRequest()
const WITH = (key: string, negate = false) => ({ kind: 'edges', edgeClass: 'any', edgePredicate: { kind: 'edgeHasProperty', key, negate } })


beforeEach(() => {
    notify.mockReset()
    asked.length = 0
    canEditLayer = false
    editing = { offered: true, blocked: null }
    entities = state({ catalog: { ...catalog(), subject: 'entities', entities: 12_400 } })
    localStorage.clear()
    usePropertyJobsStore.setState({ jobs: [], request: null } as never)
    useBranchStore.setState({ graphId: 'g1', currentBranchId: 'd1' } as never)
    useCanvasStore.setState({ selectedNodeIds: [] } as never)
    useSchemaStore.setState({ schema: { entityTypes: [], relationshipTypes: [
        { id: 'PRODUCES', name: 'Produces', visual: { strokeColor: '#f97316' } },
        { id: 'TRANSFORMS', name: 'Transforms', visual: { strokeColor: '#0ea5e9' } },
    ] } } as never)
})


describe('PropertyBrowser — the view’s relationships', () => {
    it('reads the relationships’ catalog, and says what it counts in relationship words', () => {
        renderBrowser()
        expect(asked).toContainEqual(['view-1', 'relationships'])
        expect(screen.getByText(/^Relationships between the/)).toHaveTextContent('Relationships between the 12,400 entities in this view')
        // Tiles: relationships, their properties and their types — no tags.
        for (const label of ['Relationships', 'Properties', 'Relationship types']) expect(screen.getByText(label)).toBeInTheDocument()
        expect(screen.getByText('31k')).toBeInTheDocument()
        expect(screen.queryByText('Tags')).toBeNull()
        expect(screen.getByText(/^Exact — every relationship read/)).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Filter relationship properties' })).toBeInTheDocument()

        const sla = within(card('sla'))
        expect(sla.getByText('9,300')).toBeInTheDocument()
        expect(sla.getByText(/30%/)).toBeInTheDocument()
        expect(sla.getByText('4h')).toBeInTheDocument()
    })

    it('names and colours each relationship type as the canvas draws it', async () => {
        renderBrowser()
        const chip = within(card('sla')).getByTitle('Produces').parentElement!
        expect(chip).toHaveStyle({ color: 'rgb(249, 115, 22)' })
        await userEvent.setup().click(screen.getByTitle('sla'))
        const sla = within(card('sla'))
        expect(sla.getByText('relationships use this')).toBeInTheDocument()
        expect(sla.getByText('30% of 31,200 in this view')).toBeInTheDocument()
        // Each type's bar is drawn in its colour.
        const bar = sla.getAllByText('Transforms').map((el) => el.closest('button')).find(Boolean)!
        expect(bar.querySelector('[style*="linear-gradient"]')!.getAttribute('style')).toContain('rgb(14, 165, 233)')
    })

    it('finds relationships with or without it, with a value, or of a type — as Connections searches', async () => {
        const user = userEvent.setup()
        const { onSearchPredicate } = renderBrowser()
        await user.click(within(card('sla')).getByRole('button', { name: '1d' }))
        expect(onSearchPredicate).toHaveBeenLastCalledWith({
            kind: 'edges', edgeClass: 'any', edgePredicate: { kind: 'edgeProperty', key: 'sla', op: 'eq', value: '1d', valueType: 'string' },
        })
        expect(notify).toHaveBeenLastCalledWith('info', 'Searching relationships with sla = 1d in Advanced Search')

        await user.click(screen.getByTitle('sla'))
        await user.click(screen.getByRole('button', { name: /Find relationships with this/ }))
        expect(onSearchPredicate).toHaveBeenLastCalledWith(WITH('sla'))
        expect(notify).toHaveBeenLastCalledWith('info', 'Searching relationships with sla in Advanced Search')
        await user.click(screen.getByRole('button', { name: /Find relationships without this/ }))
        expect(onSearchPredicate).toHaveBeenLastCalledWith(WITH('sla', true))

        const typeBar = within(card('sla')).getAllByText('Produces').map((el) => el.closest('button')).find(Boolean)!
        await user.click(typeBar)
        expect(onSearchPredicate).toHaveBeenLastCalledWith(
            { kind: 'edges', edgeTypes: ['PRODUCES'], edgePredicate: { kind: 'edgeHasProperty', key: 'sla', negate: false } })
        // A relationship is not tagged by an entity's display rule.
        expect(screen.queryByRole('button', { name: 'Tag matches as rule' })).toBeNull()
    })

    it('says how many hold it in their JSON, and how a mixed one is stored', async () => {
        const user = userEvent.setup()
        renderBrowser()
        await user.click(screen.getByTitle('sla'))
        expect(screen.getByText(/^Held in the relationship's JSON by 40/)).toBeInTheDocument()
        await user.click(screen.getByTitle('retries'))
        expect(screen.getByText(/A search compares each kind as its own/)).toHaveTextContent(/on 100 relationships\./)
    })

    it('opens the bulk dialog on the relationships holding a property — and from New on every one in the view', async () => {
        const user = userEvent.setup()
        renderBrowser()
        const target = { kind: 'relationshipsWithKey', key: 'sla' }
        await user.click(screen.getByRole('button', { name: 'New' }))
        expect(take()).toEqual({ target: { kind: 'viewRelationships' } })
        await user.click(within(card('sla')).getByRole('button', { name: 'Change' }))
        expect(take()).toEqual({ kind: 'set', key: 'sla', target })

        const menu = await openMenu(user, 'sla')
        expect(menu.getAllByRole('menuitem').map((item) => item.textContent))
            .toEqual(['Copy the name', 'Change', 'Rename…', 'Duplicate as…', 'Clean up…', 'Remove'])
        await user.click(menu.getByRole('menuitem', { name: 'Rename…' }))
        expect(take()).toEqual({ kind: 'rename', key: 'sla', target })
        await user.click((await openMenu(user, 'sla')).getByRole('menuitem', { name: 'Duplicate as…' }))
        expect(take()).toEqual({ kind: 'copy', key: 'sla', target })
        await user.click((await openMenu(user, 'sla')).getByRole('menuitem', { name: 'Clean up…' }))
        expect(take()).toEqual({ kind: 'normalize', key: 'sla', target })
        await user.click((await openMenu(user, 'sla')).getByRole('menuitem', { name: 'Remove' }))
        expect(take()).toEqual({ kind: 'remove', key: 'sla', target })

        // Its near-duplicates merged, and a mixed one converted — on the relationships holding it.
        await user.click(screen.getByTitle('sla'))
        await user.click(screen.getByRole('button', { name: 'Merge similar values…' }))
        expect(take()).toEqual({ kind: 'mapValues', key: 'sla', target })
        await user.click(screen.getByTitle('retries'))
        await user.click(screen.getByRole('button', { name: 'Convert all to Integer…' }))
        expect(take()).toEqual({ kind: 'convert', key: 'retries', toKind: 'Integer', target: { kind: 'relationshipsWithKey', key: 'retries' } })
    })

    it('offers to make a property a field of the relationship types carrying it — to who may edit the layer', async () => {
        const user = userEvent.setup()
        canEditLayer = true
        renderBrowser()
        await user.click((await openMenu(user, 'sla')).getByRole('menuitem', { name: 'Make it a field…' }))
        expect(screen.getByRole('dialog', { name: 'Make sla a field' })).toHaveTextContent(
            JSON.stringify({ types: SLA.byEntityType, kinds: SLA.kinds }))
    })

    it('offers no field to who may not edit the layer', async () => {
        renderBrowser()
        const menu = await openMenu(userEvent.setup(), 'sla')
        expect(menu.queryByRole('menuitem', { name: 'Make it a field…' })).toBeNull()
    })

    it('marks the properties the draft’s relationship changes touch — never an entity change’s', () => {
        const tracked = (jobId: string, patch: Partial<TrackedJob>): TrackedJob => ({
            jobId, wsId: 'ws', graphId: 'g1', branchId: 'd1', viewId: 'view-1', op: { kind: 'remove', key: 'sla' },
            targetLabel: 'every relationship with sla', startedAt: '2026-11-21T00:00:00Z',
            job: { jobId, status: 'running', progress: 0.4, processed: 400, total: 1000 }, ...patch,
        })
        usePropertyJobsStore.getState().track(tracked('e1', { entityKind: 'edge' }))
        usePropertyJobsStore.getState().track(tracked('e2', { entityKind: 'edge', op: { kind: 'set', key: 'reviewedBy', value: 'ana' } }))
        usePropertyJobsStore.getState().track(tracked('n1', { op: { kind: 'rename', key: 'retries', to: 'attempts' } }))
        renderBrowser()
        expect(within(card('sla')).getByText('removed…')).toBeInTheDocument()
        expect(within(card('retries')).queryByText(/renamed/)).toBeNull()
        // The key a relationship change gives them, before the catalog has it.
        expect(within(card('reviewedBy')).getByText('new')).toBeInTheDocument()
        expect(screen.queryByTitle('attempts')).toBeNull()
    })
})


describe('PropertyBrowser — the view’s relationships, before and without a catalog', () => {
    it('shows how far the first read has got', () => {
        renderBrowser({ catalog: null, reading: 30 })
        expect(screen.getByText(/Reading every relationship in this view/)).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
        expect(screen.getByText(/between the 12,400 entities in this view, every one counted/)).toBeInTheDocument()
    })

    it('shows what it has read so far as a floor, and how far it has got', () => {
        renderBrowser({ catalog: catalog({ status: 'running' }), reading: 42 })
        expect(screen.getByText('≥31k')).toBeInTheDocument()
        expect(screen.getByText(/Reading every relationship in this view · 42%/)).toBeInTheDocument()
        expect(within(card('sla')).getByText(/so far/)).toBeInTheDocument()
    })

    it('says when what it shows was read before the data changed', () => {
        renderBrowser({ catalog: catalog({ stale: true, asOf: new Date(Date.now() - 3_600_000).toISOString() }) })
        expect(screen.getByText(/every relationship read 1h ago/)).toBeInTheDocument()
        expect(screen.getByText(/the data has changed since/)).toHaveTextContent('Out of date — the data has changed since. Refresh to read it again.')
    })

    it('says why it can’t list them here, and where they can still be changed', () => {
        renderBrowser({ catalog: null, unavailable: true })
        expect(screen.getByText('Relationship properties can\'t be listed here')).toBeInTheDocument()
        expect(screen.getByText(/A Connections search still finds them/)).toBeInTheDocument()
    })

    it('says a read failed, and reads again', async () => {
        const refresh = vi.fn()
        renderBrowser({ catalog: null, error: 'Service Unavailable', refresh })
        expect(screen.getByText(/Couldn't read this view's relationship properties — Service Unavailable/)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
        expect(refresh).toHaveBeenCalled()
    })

    it('offers to give relationships carrying nothing a property — and says when there are none', async () => {
        renderBrowser({ catalog: catalog({ properties: [] }) })
        expect(screen.getByText('No relationship properties yet')).toBeInTheDocument()
        expect(screen.getByText(/The 31,200 relationships between the 12,400 entities in this view hold/)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: /Give them a property/ }))
        expect(take()).toEqual({ target: { kind: 'viewRelationships' } })
    })

    it('says when the view’s entities aren’t connected at all', () => {
        renderBrowser({ catalog: catalog({ properties: [], entities: 0, entityTypes: [] }) })
        expect(screen.getByText('No relationships here yet')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Give them a property/ })).toBeNull()
    })
})
