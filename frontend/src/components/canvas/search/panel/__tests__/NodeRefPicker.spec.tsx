/**
 * NodeRefPicker — an entity named by its path of display names (or a URN),
 * and what the server says the path names; picked from suggestions as its
 * name is typed, pinned by URN and back.
 */
import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetUrnLabels, urnDisplayName } from '@/lib/urnLabels'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { NodeRef, SearchResolveRequest, SearchResolveResult, SearchResultPage } from '@/types/search'

import { NodeRefList, NodeRefPicker } from '../NodeRefPicker'
import { refText, textToRef } from '../relations'
import { RelationContext } from '../relationContext'


const resolveSearchRefs = vi.fn<(...args: unknown[]) => Promise<SearchResolveResult>>()
const searchAdvanced = vi.fn<(...args: unknown[]) => Promise<SearchResultPage>>()
const provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { resolveSearchRefs, searchAdvanced })

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))

beforeEach(() => {
    resolveSearchRefs.mockReset()
    searchAdvanced.mockReset()
    __resetUrnLabels()
})


describe('NodeRefPicker — text', () => {
    it.each<[string, NodeRef | null]>([
        ['Country / United Kingdom', { path: ['Country', 'United Kingdom'] }],
        ['  ** / London', { path: ['**', 'London'] }],
        ['urn:li:dataset:1', { urn: 'urn:li:dataset:1' }],
        ['  ', null],
        [' / ', null],
    ])('reads %j', (text, ref) => {
        expect(textToRef(text)).toEqual(ref)
    })

    it('writes a slash or backslash in a name escaped, so it reads back', () => {
        const ref = { path: ['a/b', 'c'] }
        expect(refText(ref)).toBe('a\\/b / c')
        expect(textToRef(refText(ref))).toEqual(ref)
        const trailing = { path: ['a\\', 'b'] }
        expect(refText(trailing)).toBe('a\\\\ / b')
        expect(textToRef(refText(trailing))).toEqual(trailing)
    })
})


describe('NodeRefList', () => {
    it('emits a reference once one is typed, never an empty one', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const Row = () => {
            const [refs, setRefs] = useState<NodeRef[]>([])
            return <NodeRefList value={refs} onChange={(next) => { onChange(next); setRefs(next) }} />
        }
        render(<Row />)
        const input = screen.getByLabelText('Entity by name path or URN')
        await user.type(input, ' ')
        expect(onChange).not.toHaveBeenCalled()
        await user.type(input, 'Sales / orders')
        expect(onChange).toHaveBeenLastCalledWith([{ path: ['Sales', 'orders'] }])
        await user.clear(input)
        expect(onChange).toHaveBeenLastCalledWith([])
        expect(screen.getByLabelText('Entity by name path or URN')).toHaveValue('')
    })

    it('says what a path names in the view, and where', async () => {
        resolveSearchRefs.mockResolvedValue({ results: [{ count: 4, matches: [
            { urn: 'urn:1', displayName: 'London', entityType: 'city',
              ancestorPath: [{ urn: 'urn:uk', displayName: 'United Kingdom', entityType: 'country' }] },
        ] }] })
        render(
            <RelationContext.Provider value={{ depth: 0, rule: false, viewId: 'v1' }}>
                <NodeRefList value={[{ path: ['**', 'London'] }]} onChange={vi.fn()} />
            </RelationContext.Provider>,
        )
        expect(await screen.findByText('4 entities')).toBeInTheDocument()
        expect(screen.getByText(/United Kingdom \//)).toBeInTheDocument()
        expect(screen.getByText(/and 3 more — every one is used/)).toBeInTheDocument()
        expect(resolveSearchRefs).toHaveBeenCalledWith(
            { scope: { viewId: 'v1' }, refs: [{ path: ['**', 'London'] }] }, expect.anything())
    })

    it('says when a path names nothing', async () => {
        resolveSearchRefs.mockResolvedValue({ results: [{ count: 0, matches: [] }] })
        render(
            <RelationContext.Provider value={{ depth: 0, rule: false, viewId: 'v1' }}>
                <NodeRefList value={[{ path: ['Nowhere'] }]} onChange={vi.fn()} />
            </RelationContext.Provider>,
        )
        expect(await screen.findByText('not found')).toBeInTheDocument()
    })

    it('asks nothing without a view to resolve in', async () => {
        resolveSearchRefs.mockClear()
        render(<NodeRefList value={[{ path: ['Sales'] }]} onChange={vi.fn()} />)
        await act(() => new Promise((r) => setTimeout(r, 400)))
        expect(resolveSearchRefs).not.toHaveBeenCalled()
    })
})


// ---------------------------------------------------------------------------
// Suggestions, the shortest unique path, pinning
// ---------------------------------------------------------------------------

/** Entities of a small view, each with its containers' names, top first. */
const ENTITIES = {
    'urn:fin': { name: 'Finance', type: 'domain', ancestors: ['Org', 'Corp', 'EMEA'] },
    'urn:fin-ops': { name: 'Finance Ops', type: 'domain', ancestors: [] },
    'urn:orders': { name: 'orders', type: 'dataset', ancestors: ['Sales'] },
} as const
type Urn = keyof typeof ENTITIES

const resolved = (urn: Urn) => ({
    urn, displayName: ENTITIES[urn].name, entityType: ENTITIES[urn].type,
    ancestorPath: ENTITIES[urn].ancestors.map((name) => ({ urn: `urn:${name}`, displayName: name, entityType: 'folder' })),
})

/** The server: each path names the entities listed for it; a URN names itself. */
function serve(paths: Record<string, Urn[]>) {
    resolveSearchRefs.mockImplementation(async (...args: unknown[]) => {
        const { refs } = args[0] as SearchResolveRequest
        return { results: refs.map((ref) => {
            const urns = ref.urn ? (ref.urn in ENTITIES ? [ref.urn as Urn] : []) : paths[(ref.path ?? []).join(' / ')] ?? []
            return { count: urns.length, matches: urns.map(resolved) }
        }) }
    })
    searchAdvanced.mockImplementation(async (...args: unknown[]) => {
        const word = JSON.stringify(args[0]).match(/"value":"([^"]*)"/)?.[1] ?? ''
        const hits = (Object.keys(ENTITIES) as Urn[])
            .filter((urn) => ENTITIES[urn].name.toLowerCase().includes(word.toLowerCase()))
            .map((urn) => {
                const { ancestorPath, ...node } = resolved(urn)
                return { node: { ...node, properties: {} }, ancestorPath }
            })
        return { hits } as unknown as SearchResultPage
    })
}

function Picker({ initial = null, onChange }: { initial?: NodeRef | null; onChange: (next: NodeRef | null) => void }) {
    const [value, setValue] = useState<NodeRef | null>(initial)
    return (
        <RelationContext.Provider value={{ depth: 0, rule: false, viewId: 'v1' }}>
            <NodeRefPicker value={value} onChange={(next) => { onChange(next); setValue(next) }} />
        </RelationContext.Provider>
    )
}


describe('NodeRefPicker — suggestions', () => {
    it('suggests the entities whose name holds what is typed, each where it sits', async () => {
        serve({})
        const user = userEvent.setup()
        render(<Picker onChange={vi.fn()} />)
        await user.type(screen.getByRole('combobox'), 'Fin')
        expect(await screen.findByRole('option', { name: /^Finance.*Org \/ Corp \/ EMEA/ })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: /Finance Ops/ })).toBeInTheDocument()
        expect(searchAdvanced).toHaveBeenLastCalledWith(expect.objectContaining({
            predicate: { kind: 'group', op: 'and', children: [
                { kind: 'text', value: 'Fin', target: 'name', match: 'substring' }] },
            scope: { viewId: 'v1', scopeMode: 'view' },
            options: expect.objectContaining({ pageSize: 8, includeAncestorPath: true }),
        }), expect.anything())
    })

    it('picking one writes the shortest path that names only it, checked in one request', async () => {
        // Another "Finance" sits elsewhere, so the name alone isn't enough.
        serve({ '** / Finance': ['urn:fin', 'urn:fin-ops'], '** / EMEA / Finance': ['urn:fin'],
                'Org / Corp / EMEA / Finance': ['urn:fin'] })
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Picker onChange={onChange} />)
        await user.type(screen.getByRole('combobox'), 'Fin')
        await user.click(await screen.findByRole('option', { name: /^Finance.*Org \/ Corp \/ EMEA/ }))
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ path: ['**', 'EMEA', 'Finance'] }))
        expect(screen.getByRole('combobox')).toHaveValue('** / EMEA / Finance')
        expect(resolveSearchRefs).toHaveBeenCalledWith({ scope: { viewId: 'v1' }, refs: [
            { path: ['**', 'Finance'] }, { path: ['**', 'EMEA', 'Finance'] },
            { path: ['Org', 'Corp', 'EMEA', 'Finance'] }, { path: ['**', 'Corp', 'EMEA', 'Finance'] },
            { path: ['**', 'Org', 'Corp', 'EMEA', 'Finance'] },
        ] })
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
        expect(await screen.findByText('1 entity')).toBeInTheDocument()
    })

    it('is driven from the keyboard: arrows move, Enter picks, Escape closes', async () => {
        serve({ 'Finance Ops': ['urn:fin-ops'] })
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Picker onChange={onChange} />)
        const input = screen.getByRole('combobox')
        await user.type(input, 'Fin')
        await screen.findByRole('listbox')
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
        await user.type(input, 'a')
        await screen.findByRole('listbox')
        await user.keyboard('{ArrowDown}')
        expect(screen.getByRole('option', { name: /Finance Ops/ })).toHaveAttribute('aria-selected', 'true')
        await user.keyboard('{Enter}')
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ path: ['Finance Ops'] }))
    })

    it('pins an entity no path names alone, by the name it is shown with', async () => {
        serve({})
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Picker onChange={onChange} />)
        await user.type(screen.getByRole('combobox'), 'Fin')
        await user.click(await screen.findByRole('option', { name: /^Finance.*Org \/ Corp \/ EMEA/ }))
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ urn: 'urn:fin' }))
        expect(urnDisplayName('urn:fin')).toBe('Finance')
        expect(await screen.findByRole('button', { name: 'Use its name' })).toBeInTheDocument()
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })
})


describe('NodeRefPicker — pinning', () => {
    it('pins the one entity a path names, and turns it back into a name', async () => {
        serve({ 'Sales / orders': ['urn:orders'], '** / orders': ['urn:orders'] })
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Picker initial={{ path: ['Sales', 'orders'] }} onChange={onChange} />)
        await user.click(await screen.findByRole('button', { name: 'Pin this exact entity' }))
        expect(onChange).toHaveBeenLastCalledWith({ urn: 'urn:orders' })
        // Shown by name and where it sits — never the URN.
        expect(await screen.findByText('Sales')).toBeInTheDocument()
        expect(screen.getByText('orders')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('urn:orders')).not.toBeInTheDocument()
        // Its whole path reads first of two as short.
        await user.click(screen.getByRole('button', { name: 'Use its name' }))
        await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ path: ['Sales', 'orders'] }))
        expect(screen.getByRole('combobox')).toHaveValue('Sales / orders')
    })

    it('keeps an entity pinned when no path names it alone, and says why', async () => {
        serve({})
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Picker initial={{ urn: 'urn:orders' }} onChange={onChange} />)
        await user.click(await screen.findByRole('button', { name: 'Use its name' }))
        expect(await screen.findByText(/stays pinned/)).toBeInTheDocument()
        expect(onChange).not.toHaveBeenCalled()
    })

    it('opens a pinned entity for editing on Change', async () => {
        serve({})
        const user = userEvent.setup()
        render(<Picker initial={{ urn: 'urn:orders' }} onChange={vi.fn()} />)
        await user.click(await screen.findByRole('button', { name: 'Change' }))
        expect(screen.getByRole('combobox')).toHaveValue('urn:orders')
        expect(screen.getByRole('combobox')).toHaveFocus()
    })

    it('says a path starts at the top when it names nothing', async () => {
        serve({})
        render(<Picker initial={{ path: ['Finance'] }} onChange={vi.fn()} />)
        expect(await screen.findByText(/A path starts at the top/)).toBeInTheDocument()
    })
})
