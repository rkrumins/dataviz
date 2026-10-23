/**
 * NodeRefPicker — an entity named by its path of display names (or a URN),
 * and what the server says the path names.
 */
import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { NodeRef, SearchResolveResult } from '@/types/search'

import { NodeRefList } from '../NodeRefPicker'
import { refText, textToRef } from '../relations'
import { RelationContext } from '../relationContext'


const resolveSearchRefs = vi.fn<(...args: unknown[]) => Promise<SearchResolveResult>>()
const provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { resolveSearchRefs })

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))


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

    it('writes a slash in a name escaped, so it reads back', () => {
        const ref = { path: ['a/b', 'c'] }
        expect(refText(ref)).toBe('a\\/b / c')
        expect(textToRef(refText(ref))).toEqual(ref)
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
