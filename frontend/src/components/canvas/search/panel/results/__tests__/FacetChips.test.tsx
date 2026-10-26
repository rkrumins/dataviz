/**
 * The types the matches come in, as chips that change the query: narrow
 * to one (again: all types), or leave one out — counted from the rows
 * when they are all here, else as the query AND that type.
 */
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchCountsRequest, SearchHit } from '@/types/search'

import { FacetChips } from '../FacetChips'
import { excludingType, useTypeFacet } from '../useTypeFacet'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const hit = (entityType: string) => ({ node: { urn: Math.random().toString(), displayName: 'x', entityType } }) as SearchHit
const facets = [{ type: 'dataset', count: { count: 12, complete: true } },
    { type: 'chart', count: { count: 3, complete: false } }]


describe('FacetChips', () => {
    it('narrows the query to a type, and back to every type', () => {
        const onRefine = vi.fn()
        const { rerender } = render(<FacetChips facets={facets} draft={tag('PII')} onRefine={onRefine} />)
        fireEvent.click(screen.getByRole('button', { name: 'Narrow to chart: 3+' }))
        expect(onRefine).toHaveBeenLastCalledWith(all(type('chart'), tag('PII')))

        rerender(<FacetChips facets={facets} draft={all(type('chart'), tag('PII'))} onRefine={onRefine} />)
        fireEvent.click(screen.getByRole('button', { name: 'All types again, not only chart: 3+' }))
        expect(onRefine).toHaveBeenLastCalledWith(tag('PII'))
    })

    it('leaves a type out, on the query\'s own "not these types" line', () => {
        const onRefine = vi.fn()
        render(<FacetChips facets={facets} draft={tag('PII')} onRefine={onRefine} />)
        fireEvent.click(screen.getByRole('button', { name: 'Leave out dataset' }))
        expect(onRefine).toHaveBeenLastCalledWith(all(tag('PII'), { kind: 'entityType', op: 'notIn', values: ['dataset'] }))
        expect(excludingType(all(tag('PII'), { kind: 'entityType', op: 'notIn', values: ['dataset'] }), 'chart'))
            .toEqual(all(tag('PII'), { kind: 'entityType', op: 'notIn', values: ['dataset', 'chart'] }))
    })
})


describe('useTypeFacet', () => {
    function wrapper({ children }: { children: ReactNode }) {
        const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
        Object.assign(provider, { searchCounts: vi.fn(async (body: SearchCountsRequest) => ({
            counts: Object.fromEntries(body.items.map((i) => [i.id, { count: 40, status: 'complete' }])),
        })) })
        return (
            <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
                workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
                {children}
            </ProviderOverride>
        )
    }
    const hits = [hit('dataset'), hit('dataset'), hit('chart')]

    it('counts from the rows when every match is here', () => {
        const { result } = renderHook(() => useTypeFacet('view-a', tag('PII'), hits, 3), { wrapper })
        expect(result.current).toEqual([
            { type: 'dataset', count: { count: 2, complete: true } },
            { type: 'chart', count: { count: 1, complete: true } },
        ])
    })

    it('else counts each type as the query AND that type, the rows a floor till then', async () => {
        const { result } = renderHook(() => useTypeFacet('view-a', tag('PII'), hits, 500), { wrapper })
        expect(result.current[0].count).toEqual({ count: 2, complete: false })
        await waitFor(() => expect(result.current[0].count).toMatchObject({ count: 40, complete: true }))
    })
})
