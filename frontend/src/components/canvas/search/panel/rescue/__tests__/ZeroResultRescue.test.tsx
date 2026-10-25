/**
 * An empty answer, led by where it went empty — over the results and on
 * the Sentence line itself, before anything runs — with the fixes that
 * would find something, each counted, one click to apply.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchCountsRequest, SearchQuery, SearchResultPage } from '@/types/search'

import { ZeroResultsDiagnostic } from '../../../ZeroResultsDiagnostic'
import { SentenceBuilder } from '../../sentence/SentenceBuilder'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const draft = all(type('dataset'), tag('Certified'), tag('PII'))

/** Nothing is tagged PII: whatever needs it counts nothing. */
const needsPII = (p: Predicate): boolean => p.kind === 'tag' ? p.values.includes('PII')
    : p.kind === 'group' ? (p.op === 'or' ? p.children.every(needsPII) : p.children.some(needsPII)) : false

function wrapper({ children }: { children: ReactNode }) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    Object.assign(provider, {
        searchCounts: vi.fn(async (body: SearchCountsRequest) => ({
            counts: Object.fromEntries(body.items.map((i) => [i.id, { count: needsPII(i.predicate) ? 0 : 5, status: 'complete' }])),
        })),
    })
    return (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
}

const EMPTY = { hits: [], candidateCount: 0, truncated: false, deadlineExceeded: false, cacheHit: false,
    elapsedMs: 3 } as unknown as SearchResultPage


describe('the rescue', () => {
    beforeEach(() => useSearchStore.getState().clear())

    it('leads an empty answer with the line where the matches run out, and the fixes', async () => {
        const onApplyFix = vi.fn()
        render(<ZeroResultsDiagnostic result={EMPTY} query={{ predicate: draft } as SearchQuery} viewId="view-a"
                                      draft={draft} onApplyFix={onApplyFix} />, { wrapper })
        expect(await screen.findByText('“are tagged #PII”')).toBeInTheDocument()
        // Each fix is offered once it is known to find something.
        expect(await screen.findByRole('button', { name: /Match any condition, not all\s*5/ })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Without “are tagged #PII”/ }))
        expect(onApplyFix).toHaveBeenCalledWith(all(type('dataset'), tag('Certified')))
    })

    it('marks the Sentence line where the matches run out, before anything runs', async () => {
        const onCommit = vi.fn()
        function Harness() {
            const [p, setP] = useState<Predicate | null>(draft)
            return (
                <SentenceBuilder viewId="view-a" predicate={p} onSeed={setP}
                                 onCommit={(next) => { onCommit(next); setP(next) }}
                                 discovery={{ allKeys: [], keysByEntityType: {}, tagValues: [], getValueSamples: () => [] }}
                                 knownEntityTypes={['dataset']} presentEntityTypes={['dataset']} discoveredLayers={[]}
                                 onEditInCode={() => {}} />
            )
        }
        render(<Harness />, { wrapper })
        expect(await screen.findByRole('status')).toHaveTextContent('Nothing matches from here')
        // And says so, for anyone not watching the counts.
        expect(await screen.findByText(/^Nothing matches: the matches run out at “/)).toHaveAttribute('aria-live', 'polite')
        fireEvent.click(await screen.findByRole('button', { name: /Without this line/ }))
        expect(onCommit).toHaveBeenCalledWith(all(type('dataset'), tag('Certified')))
    })
})
