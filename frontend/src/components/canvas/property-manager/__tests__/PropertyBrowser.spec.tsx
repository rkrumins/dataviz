/**
 * PropertyBrowser — the Properties tab read from the view's exact property
 * catalog: every key with how many entities carry it, its kinds (mixed ones
 * flagged and explained), its range, its values with exact counts (or that
 * it has too many to list), the tags with their counts — and the searches
 * and rules it hands off, typed as the values are stored.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import type { SearchCatalogProperty, SearchCatalogResult } from '@/types/search'

import { PropertyBrowser } from '../PropertyBrowser'


const notify = vi.fn()
let state: PropertyCatalogState

vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => state,
}))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
vi.mock('../PropertyOperationDialog', () => ({
    PropertyOperationDialog: () => <div>operation dialog</div>,
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

function renderBrowser(over: Partial<PropertyCatalogState> = {}) {
    state = { catalog: catalog(), reading: null, error: null, unavailable: false, refresh: vi.fn(), ...over }
    const onSearchPredicate = vi.fn()
    const onCreateRuleFromPredicate = vi.fn()
    render(
        <PropertyBrowser
            viewId="view-1" knownEntityTypes={[]} knownLayers={[]}
            onSearchPredicate={onSearchPredicate}
            onCreateRuleFromPredicate={onCreateRuleFromPredicate}
        />,
    )
    return { onSearchPredicate, onCreateRuleFromPredicate }
}

/** A property's card, found by its (monospaced) name. */
function card(key: string): HTMLElement {
    return screen.getByTitle(key).closest('.group') as HTMLElement
}


describe('PropertyBrowser', () => {
    beforeEach(() => notify.mockReset())

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
        await user.click(within(card('owner')).getByRole('button', { name: 'Copy the name' }))
        await expect(navigator.clipboard.readText()).resolves.toBe('owner')
        expect(notify).toHaveBeenCalledWith('success', 'Copied “owner”')
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
