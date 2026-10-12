/**
 * A path card must not contradict itself.
 *
 * The arrows between the node chips already read the system edge type in
 * plain English ("Combined flow"). The summary line at the top of the same
 * card printed the raw ids, so one card said `AGGREGATED → FLOWS_TO` above
 * arrows that said `Combined flow`. Both lines are the same fact and must
 * use the same words. Every other type still shows exactly what it showed
 * before — only the system type has copy of its own.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { PathHit } from '@/types/search'

import { PathResultPanel } from '../PathResultPanel'


const PATH = {
    hopCount: 2,
    nodes: [
        { urn: 'urn:a', displayName: 'A', entityType: 'Table' },
        { urn: 'urn:b', displayName: 'B', entityType: 'Table' },
        { urn: 'urn:c', displayName: 'C', entityType: 'Table' },
    ],
    edges: [
        { edgeType: 'AGGREGATED', sourceUrn: 'urn:a', targetUrn: 'urn:b' },
        { edgeType: 'FLOWS_TO', sourceUrn: 'urn:b', targetUrn: 'urn:c' },
    ],
} as unknown as PathHit


describe('PathResultPanel edge-type wording', () => {
    it('the header summary reads the system type in the same words as the arrows', () => {
        render(<PathResultPanel paths={[PATH]} />)

        expect(screen.getByText('Combined flow → FLOWS_TO')).toBeTruthy()
        expect(screen.queryByText('AGGREGATED → FLOWS_TO')).toBeNull()
    })

    it('a type with no copy of its own is printed unchanged', () => {
        const plain = {
            hopCount: 1,
            nodes: [
                { urn: 'urn:a', displayName: 'A', entityType: 'Table' },
                { urn: 'urn:b', displayName: 'B', entityType: 'Table' },
            ],
            edges: [{ edgeType: 'FLOWS_TO', sourceUrn: 'urn:a', targetUrn: 'urn:b' }],
        } as unknown as PathHit

        render(<PathResultPanel paths={[plain]} />)

        // Once in the summary line, once on the arrow — both untouched.
        expect(screen.getAllByText('FLOWS_TO')).toHaveLength(2)
    })
})
