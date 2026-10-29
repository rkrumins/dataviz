/**
 * A Connections search's matches of an edge type the reader hid on the
 * canvas stay hidden there; the match bar says how many, and shows them on
 * a click — unhiding those types, and only those, for this view.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useConnectionVisibilityStore } from '@/store/connectionVisibility'
import { type MatchedEdge, useSearchStore } from '@/store/searchStore'

import { MatchBar } from '../MatchBar'


const matched = (i: number, edgeType: string): MatchedEdge => ({
    key: `k${i}`, id: `e${i}`, source: 'a', target: `b${i}`, edgeType, sourceChain: [], targetChain: [],
})

function answer(edges: MatchedEdge[]) {
    useSearchStore.getState().setResult({
        viewId: 'view-1', matchUrns: ['a'], edgeKeys: edges.map((e) => e.key), matchedEdges: edges, queryHash: 'q',
    })
}

const renderBar = () => render(
    <MatchBar count={3} elapsedMs={4} isRunning={false} unit="connection" viewId="view-1" />)


describe('MatchBar — connections of hidden edge types', () => {
    beforeEach(() => {
        useSearchStore.getState().clear()
        useConnectionVisibilityStore.setState({ hiddenByView: {} })
    })

    it('says how many are hidden, and shows them by unhiding their types alone', () => {
        answer([matched(1, 'defined_by'), matched(2, 'DEFINED_BY'), matched(3, 'TRANSFORMS')])
        useConnectionVisibilityStore.setState({ hiddenByView: { 'view-1': ['DEFINED_BY', 'TAGGED_WITH'] } })
        renderBar()

        expect(screen.getByText('2 of these connections are of a type hidden on the canvas.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Show them' }))
        expect(useConnectionVisibilityStore.getState().hiddenByView['view-1']).toEqual(['TAGGED_WITH'])
        expect(screen.queryByRole('button', { name: 'Show them' })).not.toBeInTheDocument()
    })

    it('says nothing when none of them is hidden', () => {
        answer([matched(1, 'TRANSFORMS')])
        useConnectionVisibilityStore.setState({ hiddenByView: { 'view-1': ['DEFINED_BY'] } })
        renderBar()
        expect(screen.queryByText(/hidden on the canvas/)).not.toBeInTheDocument()
    })
})
