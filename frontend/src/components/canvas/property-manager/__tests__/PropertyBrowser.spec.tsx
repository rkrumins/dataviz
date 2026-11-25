/**
 * PropertyBrowser — the Properties tab read from the view's exact property
 * catalog: every key with how many entities carry it, its kinds (mixed ones
 * flagged and explained), its range, its values with exact counts (or that
 * it has too many to list), the tags with their counts — and the searches
 * and rules it hands off, typed as the values are stored. Changes open the
 * one bulk-change dialog; the draft's changes are listed as they run and
 * once they end, and mark the properties they touch.
 */
import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import {
    NO_DRAFT, NO_VERSION_CONTROL, type EntityEditing,
} from '@/features/versioning/hooks/useEntityEditing'
import type { SearchCatalogProperty, SearchCatalogResult } from '@/types/search'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'

import { PropertyBrowser } from '../PropertyBrowser'


const notify = vi.fn()
let state: PropertyCatalogState
let editing: EntityEditing

vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => state,
}))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
    useEntityEditing: () => editing,
}))


function property(over: Partial<SearchCatalogProperty> & { key: string }): SearchCatalogProperty {
    return {
        count: 0, distinct: 0, distinctExact: true, byEntityType: {}, kinds: {},
        values: [], residual: 0, ...over,
    }
}

const OWNER = property({
    key: 'owner', count: 900, byEntityType: { Dataset: 600, Column: 300 }, kinds: { String: 900 },
    distinct: 2, values: [
        { value: 'ann', kind: 'String', count: 700 }, { value: 'bob', kind: 'String', count: 200 },
    ],
})
const IS_PII = property({
    key: 'isPii', count: 800, kinds: { Boolean: 600, String: 200 }, distinct: 3, values: [
        { value: false, kind: 'Boolean', count: 500 }, { value: 'true', kind: 'String', count: 200 },
        { value: true, kind: 'Boolean', count: 100 },
    ],
})
const GV = property({
    key: 'gvId', count: 1000, kinds: { Integer: 1000 }, distinct: 2000, distinctExact: false,
    min: '-9223372036854775808', max: '9223372036854775807',
})
const LEGACY = property({
    key: 'legacyCode', count: 12, kinds: { String: 12 }, distinct: 1, residual: 12,
    values: [{ value: 'x', kind: 'String', count: 12 }],
})

function catalog(over: Partial<SearchCatalogResult> = {}): SearchCatalogResult {
    return {
        sessionId: 's', status: 'complete', stale: false, entities: 1000,
        asOf: new Date().toISOString(),
        entityTypes: [{ type: 'Dataset', count: 700 }, { type: 'Column', count: 300 }],
        properties: [GV, OWNER, IS_PII, LEGACY],
        tags: [{ tag: 'pii', count: 150 }, { tag: 'gold', count: 20 }],
        ...over,
    }
}

// The Promote offer reads the data source's semantic layer.
const queryClient = new QueryClient()
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

function renderBrowser(over: Partial<PropertyCatalogState> = {}) {
    state = { catalog: catalog(), reading: null, error: null, unavailable: false, refresh: vi.fn(), ...over }
    const onSearchPredicate = vi.fn()
    const onCreateRuleFromPredicate = vi.fn()
    render(
        <PropertyBrowser
            viewId="view-1"
            onSearchPredicate={onSearchPredicate}
            onCreateRuleFromPredicate={onCreateRuleFromPredicate}
        />,
        { wrapper },
    )
    return { onSearchPredicate, onCreateRuleFromPredicate }
}

/** A property's card, found by its (monospaced) name. */
function card(key: string): HTMLElement {
    return screen.getByTitle(key).closest('.group') as HTMLElement
}

/** Open a property's More actions menu; its items are portalled, out of the card. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, key: string) {
    await user.click(within(card(key)).getByRole('button', { name: `More actions for ${key}` }))
    return within(await screen.findByRole('menu'))
}


describe('PropertyBrowser', () => {
    beforeEach(() => {
        notify.mockReset()
        editing = { offered: true, blocked: null }
    })

    it('lists every property, most carried first, with its exact coverage and values', () => {
        renderBrowser()
        const names = screen.getAllByTitle(/^(gvId|owner|isPii|legacyCode)$/).map((el) => el.textContent)
        expect(names).toEqual(['gvId', 'owner', 'isPii', 'legacyCode'])
        const owner = within(card('owner'))
        expect(owner.getByText('900')).toBeInTheDocument()
        expect(owner.getByText(/90%/)).toBeInTheDocument()
        expect(owner.getByText('2 values')).toBeInTheDocument()
        expect(owner.getByText('ann')).toBeInTheDocument()
        expect(within(card('gvId')).getByText('2,000+ values')).toBeInTheDocument()
    })

    it('lists the tags with how many entities carry each', () => {
        const { onCreateRuleFromPredicate } = renderBrowser()
        expect(screen.getByText('pii')).toBeInTheDocument()
        expect(screen.getByText('150')).toBeInTheDocument()
        screen.getByText('gold').click()
        expect(onCreateRuleFromPredicate).toHaveBeenCalledWith(
            { kind: 'tag', op: 'hasAny', values: ['gold'] }, 'gold')
    })

    it('flags a key stored as two kinds, and says so plainly when opened', async () => {
        renderBrowser()
        const pii = within(card('isPii'))
        expect(pii.getByText('mixed')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByTitle('isPii'))
        expect(screen.getByText(/A search compares each kind as its own/)).toBeInTheDocument()
        expect(within(card('isPii')).getByText('Boolean')).toBeInTheDocument()
    })

    it('searches a value as the kind it is stored as', async () => {
        const user = userEvent.setup()
        const { onSearchPredicate } = renderBrowser()
        const pii = within(card('isPii'))
        await user.click(pii.getByText('false'))
        expect(onSearchPredicate).toHaveBeenCalledWith(
            { kind: 'property', key: 'isPii', op: 'eq', value: false, valueType: 'boolean' })
        // The text "true" and the boolean true read apart, and search apart.
        await user.click(pii.getByText('true (Text)'))
        expect(onSearchPredicate).toHaveBeenLastCalledWith(
            { kind: 'property', key: 'isPii', op: 'eq', value: 'true', valueType: 'string' })
        await user.click(pii.getByText('true (Boolean)'))
        expect(onSearchPredicate).toHaveBeenLastCalledWith(
            { kind: 'property', key: 'isPii', op: 'eq', value: true, valueType: 'boolean' })
    })

    it('shows the exact range of a number, and that it has too many values to list', async () => {
        renderBrowser()
        await userEvent.setup().click(screen.getByTitle('gvId'))
        expect(screen.getByText('-9223372036854775808')).toBeInTheDocument()
        expect(screen.getByText('9223372036854775807')).toBeInTheDocument()
        expect(screen.getByText(/More than 2,000 distinct values/)).toBeInTheDocument()
    })

    it('says when entities hold a key past the native-property budget', async () => {
        renderBrowser()
        await userEvent.setup().click(screen.getByTitle('legacyCode'))
        expect(screen.getByText(/12 entities hold it past the graph's native-property budget/))
            .toBeInTheDocument()
    })

    it('filters properties and tags, and sorts A–Z', async () => {
        const user = userEvent.setup()
        renderBrowser()
        await user.type(screen.getByRole('textbox', { name: 'Filter properties and tags' }), 'pi')
        expect(screen.getAllByTitle(/^(gvId|owner|isPii|legacyCode)$/).map((e) => e.textContent))
            .toEqual(['isPii'])
        expect(screen.getByText('pii')).toBeInTheDocument()
        expect(screen.queryByText('gold')).not.toBeInTheDocument()
        await user.clear(screen.getByRole('textbox', { name: 'Filter properties and tags' }))
        await user.click(screen.getByRole('button', { name: 'A–Z' }))
        expect(screen.getAllByTitle(/^(gvId|owner|isPii|legacyCode)$/).map((e) => e.textContent))
            .toEqual(['gvId', 'isPii', 'legacyCode', 'owner'])
    })

    it('draws a hundred rows at a time', async () => {
        const many = Array.from({ length: 150 }, (_, i) => property({ key: `key${String(i).padStart(3, '0')}`, count: 1 }))
        renderBrowser({ catalog: catalog({ properties: many }) })
        expect(screen.getAllByTitle(/^key\d{3}$/)).toHaveLength(100)
        await userEvent.setup().click(screen.getByRole('button', { name: /Show 50 more of 50/ }))
        expect(screen.getAllByTitle(/^key\d{3}$/)).toHaveLength(150)
    })

    it('copies a property name', async () => {
        // user-event puts a clipboard of its own on the navigator.
        const user = userEvent.setup()
        renderBrowser()
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Copy the name' }))
        await expect(navigator.clipboard.readText()).resolves.toBe('owner')
        expect(notify).toHaveBeenCalledWith('success', 'Copied “owner”')
    })

    it('opens and closes a row from its chevron, and not from its actions', async () => {
        const user = userEvent.setup()
        renderBrowser()
        const header = () => screen.getByTitle('owner').closest('[role="button"]')!
        const chevron = card('owner').querySelector('.lucide-chevron-right')!
        await user.click(chevron)
        expect(header()).toHaveAttribute('aria-expanded', 'true')
        await user.click(chevron)
        expect(header()).toHaveAttribute('aria-expanded', 'false')
        // An action runs on its own: the row stays as it was.
        await user.click(within(card('owner')).getByRole('button', { name: 'Clean up…' }))
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Create rule' }))
        expect(header()).toHaveAttribute('aria-expanded', 'false')
    })

    it('keeps at most two actions on the row, and every one in its More actions menu, which runs them', async () => {
        const user = userEvent.setup()
        const { onCreateRuleFromPredicate } = renderBrowser()
        const owner = within(card('owner'))
        const actions = ['Copy the name', 'Change', 'Duplicate as…', 'Clean up…', 'Make it a field…', 'Create rule', 'Remove']
        expect(owner.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((n) => actions.includes(n!)))
            .toEqual(['Change', 'Clean up…'])

        const menu = await openMenu(user, 'owner')
        expect(menu.getAllByRole('menuitem').map((item) => item.textContent))
            .toEqual(['Copy the name', 'Change', 'Duplicate as…', 'Clean up…', 'Create rule', 'Remove'])
        await user.click(menu.getByRole('menuitem', { name: 'Change' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'set', key: 'owner' })
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Clean up…' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'normalize', key: 'owner' })
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Create rule' }))
        expect(onCreateRuleFromPredicate).toHaveBeenCalledWith({ kind: 'hasProperty', key: 'owner', negate: false }, 'owner')
    })

    it('works its menu from the keyboard, and puts the focus back on More actions', async () => {
        const user = userEvent.setup()
        renderBrowser()
        const more = within(card('owner')).getByRole('button', { name: 'More actions for owner' })
        more.focus()
        await user.keyboard('{Enter}')
        expect(await screen.findByRole('menu')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Copy the name' })).toHaveFocus())
        await user.keyboard('{ArrowDown}')
        expect(screen.getByRole('menuitem', { name: 'Change' })).toHaveFocus()
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        await waitFor(() => expect(more).toHaveFocus())
        // None of it opened the row.
        expect(screen.getByTitle('owner').closest('[role="button"]')).toHaveAttribute('aria-expanded', 'false')
    })

    it('shows how far the first read has got before anything is read', () => {
        renderBrowser({ catalog: null, reading: 20 })
        expect(screen.getByText(/Reading every entity in this view/)).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
    })

    it('says when a view has no catalog here, instead of offering to create a first property', () => {
        renderBrowser({ catalog: null, unavailable: true })
        expect(screen.getByText(/aren't available for this view here/)).toBeInTheDocument()
        expect(screen.queryByText(/Create your first property/)).not.toBeInTheDocument()
    })
})


describe('PropertyBrowser — a property is changed only in a draft', () => {
    beforeEach(() => { editing = { offered: true, blocked: null } })

    it('opens the bulk-change dialog from New, and from a property: Change, Duplicate as…, Remove', async () => {
        const user = userEvent.setup()
        renderBrowser()
        await user.click(screen.getByRole('button', { name: 'New' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({})
        const owner = within(card('owner'))
        await user.click(owner.getByRole('button', { name: 'Change' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'set', key: 'owner' })
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Duplicate as…' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'copy', key: 'owner' })
        await user.click((await openMenu(user, 'owner')).getByRole('menuitem', { name: 'Remove' }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'remove', key: 'owner' })
    })

    it('disables them on a data source without version control, and says why', async () => {
        editing = { offered: true, blocked: NO_VERSION_CONTROL }
        renderBrowser()
        const user = userEvent.setup()
        const create = screen.getByRole('button', { name: 'New' })
        expect(create).toBeDisabled()
        await user.hover(create.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_VERSION_CONTROL)
        await user.unhover(create.parentElement!)

        const owner = within(card('owner'))
        const update = owner.getByRole('button', { name: 'Change' })
        expect(update).toBeDisabled()
        await user.hover(update.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_VERSION_CONTROL)
        await user.unhover(update.parentElement!)

        const menu = await openMenu(user, 'owner')
        const remove = menu.getByRole('menuitem', { name: 'Remove' })
        expect(remove).toHaveAttribute('aria-disabled', 'true')
        await user.hover(remove.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_VERSION_CONTROL)
        // Reading, searching and rules are not edits to the graph.
        expect(menu.getByRole('menuitem', { name: 'Create rule' })).not.toHaveAttribute('aria-disabled')
        expect(menu.getByRole('menuitem', { name: 'Copy the name' })).not.toHaveAttribute('aria-disabled')
    })

    it('says why on the first-property call to action too', async () => {
        editing = { offered: true, blocked: NO_DRAFT }
        renderBrowser({ catalog: catalog({ properties: [], tags: [] }) })
        const cta = screen.getByRole('button', { name: /Create your first property/ })
        expect(cta).toBeDisabled()
        await userEvent.setup().hover(cta.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_DRAFT)
    })

    it('cleans up a property’s values from its row, its near-duplicates, its kinds and its value bars', async () => {
        const user = userEvent.setup()
        const DEPT = property({
            key: 'dept', count: 300, kinds: { String: 300 }, distinct: 3, values: [
                { value: 'Finance', kind: 'String', count: 200 }, { value: 'finance ', kind: 'String', count: 80 },
                { value: 'Ops', kind: 'String', count: 20 },
            ],
        })
        renderBrowser({ catalog: catalog({ properties: [OWNER, IS_PII, DEPT] }) })
        const take = () => usePropertyJobsStore.getState().consumeRequest()

        await user.click(within(card('owner')).getByRole('button', { name: 'Clean up…' }))
        expect(take()).toEqual({ kind: 'normalize', key: 'owner' })

        // Values that differ only in case or spaces: flagged, and merged in one go.
        expect(within(card('owner')).queryByText('similar values')).not.toBeInTheDocument()
        expect(within(card('dept')).getByText('similar values')).toBeInTheDocument()
        await user.click(screen.getByTitle('dept'))
        expect(screen.getByText(/differ only in case or spaces/)).toHaveTextContent('“Finance”, “finance ” differ only in case or spaces')
        await user.click(screen.getByRole('button', { name: 'Merge similar values…' }))
        expect(take()).toEqual({ kind: 'mapValues', key: 'dept' })

        // Values picked from the bars: merged into the most held of them.
        const dept = within(card('dept'))
        await user.click(dept.getByRole('checkbox', { name: 'Pick Ops' }))
        expect(dept.getByRole('button', { name: /Merge into/ })).toBeDisabled()
        await user.click(dept.getByRole('checkbox', { name: 'Pick Finance' }))
        expect(dept.getByText('2 values picked — they become one')).toBeInTheDocument()
        await user.click(dept.getByRole('button', { name: /Merge into/ }))
        expect(take()).toEqual({ kind: 'mapValues', key: 'dept', map: [{ from: 'Ops', fromKind: 'String', to: 'Finance', toKind: 'String' }] })

        // Stored as two kinds: converted to the one most of its entities hold.
        await user.click(screen.getByTitle('isPii'))
        await user.click(screen.getByRole('button', { name: 'Convert all to Boolean…' }))
        expect(take()).toEqual({ kind: 'convert', key: 'isPii', toKind: 'Boolean' })
    })

    it('merges the values picked, by value — however the list reorders as the catalog is read', async () => {
        const user = userEvent.setup()
        const dept = (values: SearchCatalogProperty['values']) => property({
            key: 'dept', count: 600, kinds: { String: 600 }, distinct: 3, values,
        })
        const finance = { value: 'Finance', kind: 'String', count: 200 }
        const spaced = { value: 'finance ', kind: 'String', count: 80 }
        const browser = () => <PropertyBrowser viewId="view-1" onCreateRuleFromPredicate={vi.fn()} />
        state = { catalog: catalog({ status: 'running', properties: [dept([finance, spaced, { value: 'Ops', kind: 'String', count: 20 }])] }),
                  reading: 50, error: null, unavailable: false, refresh: vi.fn() }
        const view = render(browser(), { wrapper })
        await user.click(screen.getByTitle('dept'))
        await user.click(within(card('dept')).getByRole('checkbox', { name: 'Pick Ops' }))
        await user.click(within(card('dept')).getByRole('checkbox', { name: 'Pick Finance' }))

        // The read goes on: Ops is now the most held, and every value moves.
        state = { ...state, reading: null, catalog: catalog({ properties: [dept([{ value: 'Ops', kind: 'String', count: 320 }, finance, spaced])] }) }
        view.rerender(browser())
        const row = within(card('dept'))
        expect(row.getByRole('checkbox', { name: 'Pick Ops' })).toBeChecked()
        expect(row.getByRole('checkbox', { name: 'Pick Finance' })).toBeChecked()
        expect(row.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(2)
        await user.click(row.getByRole('button', { name: /Merge into/ }))
        expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({
            kind: 'mapValues', key: 'dept', map: [{ from: 'Finance', fromKind: 'String', to: 'Ops', toKind: 'String' }],
        })
    })

    it('offers no change at all where editing is off', async () => {
        editing = { offered: false, blocked: NO_DRAFT }
        renderBrowser()
        expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument()
        const owner = within(card('owner'))
        expect(owner.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
        expect(owner.queryByRole('button', { name: 'Clean up…' })).not.toBeInTheDocument()
        const menu = await openMenu(userEvent.setup(), 'owner')
        expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy the name', 'Create rule'])
    })
})


describe('PropertyBrowser — the draft\'s bulk changes', () => {
    const tracked = (jobId: string, patch: Partial<TrackedJob>): TrackedJob => ({
        jobId, wsId: 'ws', graphId: 'g1', branchId: 'd1', viewId: 'view-1',
        op: { kind: 'rename', key: 'owner', to: 'steward' }, targetLabel: 'every entity in this view',
        startedAt: '2026-11-21T00:00:00Z', job: { jobId, status: 'running', progress: 0.4, processed: 400, total: 1000 }, ...patch,
    })

    beforeEach(() => {
        editing = { offered: true, blocked: null }
        localStorage.clear()
        useBranchStore.setState({ graphId: 'g1', currentBranchId: 'd1' } as never)
        usePropertyJobsStore.setState({ jobs: [], request: null } as never)
        useCanvasStore.setState({ selectedNodeIds: [], drawerNodeIds: null, drawerNodeId: null, drawerDirty: false, pendingDrawerMove: null } as never)
    })

    it('lists one being applied, with how far it has got — and marks the property it changes', () => {
        usePropertyJobsStore.getState().track(tracked('j1', {}))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getByText('Rename owner → steward')).toBeInTheDocument()
        expect(panel.getByText('400 of 1,000')).toBeInTheDocument()
        expect(panel.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
        expect(within(card('owner')).getByText('renamed…')).toBeInTheDocument()
        // The new name, which none of the published entities holds yet.
        expect(screen.getByText('new')).toBeInTheDocument()
    })

    it('lists no relationship’s new key as an entity property — the catalog lists entities’', () => {
        usePropertyJobsStore.getState().track(tracked('j9', {
            op: { kind: 'set', key: 'via_pipeline', value: 'nightly' }, entityKind: 'edge',
            targetLabel: 'the picked relationships',
        }))
        renderBrowser()
        // The change itself is listed, as any of the draft's are…
        expect(within(screen.getByRole('region', { name: 'Changes on this draft' })).getByText(/via_pipeline/)).toBeInTheDocument()
        // …but no entity property row comes with it.
        expect(screen.queryByText('new')).toBeNull()
    })

    it('says what one that ended did, and offers why some could not be changed', () => {
        usePropertyJobsStore.getState().track(tracked('j2', {
            op: { kind: 'remove', key: 'legacyCode' },
            job: { jobId: 'j2', status: 'completed', summary: {
                changed: 9, unchanged: 1, missing: 1, conflicts: 0,
                refused: { count: 3, byReason: { missing: 1, write_refused: 2 }, examples: [] },
            } },
        }))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getByText(/changed/).textContent).toMatch(/9 changed · 1 left as they were · 1 not in the draft · 2 couldn’t be/)
        expect(panel.getByRole('button', { name: 'Which, and why' })).toBeInTheDocument()
        panel.getByRole('button', { name: 'Dismiss' }).click()
        expect(usePropertyJobsStore.getState().jobs).toEqual([])
    })

    it('says what a convert left alone, and when what it changed has been published', () => {
        usePropertyJobsStore.getState().track(tracked('j3', {
            op: { kind: 'convert', key: 'isPii', toKind: 'Boolean', onFail: 'skip' },
            job: { jobId: 'j3', status: 'completed', summary: {
                changed: 200, unchanged: 600, unconvertible: 4, conflicts: 0, publishedCommitId: 'cmt_9',
                refused: { count: 4, byReason: { unconvertible: 4 }, examples: [] },
            } },
        }))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getByText('Convert isPii to Boolean')).toBeInTheDocument()
        expect(panel.getByText(/200/).closest('p')!.textContent).toMatch(/200 changed · 600 left as they were · 4 wouldn’t convert/)
        expect(panel.getByText(/Published — listed in the publish’s audit/)).toBeInTheDocument()
        expect(panel.getByRole('button', { name: 'Which, and why' })).toBeInTheDocument()
    })

    it('says how many a search no longer matched on the draft, and why its matches were judged as published', () => {
        usePropertyJobsStore.getState().track(tracked('j6', {
            op: { kind: 'set', key: 'tier', value: 'gold' },
            job: { jobId: 'j6', status: 'completed', summary: {
                changed: 40, unchanged: 0, conflicts: 0, noLongerMatches: 3,
                refused: { count: 3, byReason: { no_longer_matches: 3 }, examples: [] },
                recheck: { exact: false, note: 'Your draft changed more than 200,000 entities, so its matches were judged as published.' },
            } },
        }))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getByText(/40/).closest('p')!.textContent)
            .toMatch(/40 changed · 3 no longer matched the search on your draft — left as they are/)
        expect(panel.getByText('Your draft changed more than 200,000 entities, so its matches were judged as published.'))
            .toBeInTheDocument()
    })

    it('says why a search checked on the draft didn’t reach the entities new in it', () => {
        const note = 'Your draft changed more than 200,000 entities, so entities new in your draft, or changed there to match, weren’t searched.'
        const summary = { changed: 5, unchanged: 0, conflicts: 0, refused: { count: 0, byReason: {}, examples: [] } }
        usePropertyJobsStore.getState().track(tracked('j7', {
            op: { kind: 'set', key: 'tier', value: 'gold' },
            job: { jobId: 'j7', status: 'completed', summary: { ...summary, recheck: { exact: true, note } } },
        }))
        usePropertyJobsStore.getState().track(tracked('j8', {
            op: { kind: 'set', key: 'tier', value: 'gold' },
            job: { jobId: 'j8', status: 'completed', summary: { ...summary, recheck: { exact: true, note: null } } },
        }))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getAllByText(note)).toHaveLength(1)
    })

    it('says when it lost track of one, and offers to check again — or to dismiss it', async () => {
        const user = userEvent.setup()
        usePropertyJobsStore.getState().track(tracked('j4', { lost: { at: '2026-11-21T00:00:00Z', message: 'Failed to fetch' } }))
        usePropertyJobsStore.getState().track(tracked('j5', { lost: { at: '2026-11-21T00:00:00Z', message: 'the server no longer has it', gone: true } }))
        renderBrowser()
        const panel = within(screen.getByRole('region', { name: 'Changes on this draft' }))
        expect(panel.getByText(/Lost track of this change: Failed to fetch/)).toBeInTheDocument()
        expect(panel.getByText(/can’t be found on the server any more/)).toBeInTheDocument()
        expect(panel.queryByRole('button', { name: 'Stop' })).toBeNull()
        await user.click(panel.getByRole('button', { name: 'Check again' }))
        expect(usePropertyJobsStore.getState().jobs.find((j) => j.jobId === 'j4')!.lost?.checking).toBe(true)
        await user.click(panel.getAllByRole('button', { name: 'Dismiss' })[0]!)
        expect(usePropertyJobsStore.getState().jobs.map((j) => j.jobId)).toEqual(['j4'])
    })

    it('offers to compare several entities selected on the canvas', async () => {
        useCanvasStore.setState({ selectedNodeIds: ['a', 'b', 'logical:g'] } as never)
        renderBrowser()
        await userEvent.setup().click(screen.getByRole('button', { name: /2 selected on the canvas/ }))
        expect(useCanvasStore.getState().drawerNodeIds).toEqual(['a', 'b'])
    })
})
