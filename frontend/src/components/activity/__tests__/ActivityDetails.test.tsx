/**
 * What an event recorded, as what changed: one setting as before → after, a
 * group of settings as a before → after each, the fields an update set, and
 * the rest as labelled values — with the ids in it named.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { ActivityDetails, splitChanges } from '../ActivityDetails'

function wrap(ui: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('splitChanges', () => {
    it('reads each recorded shape of a change', () => {
        expect(splitChanges({ from: '0 3 * * *', to: null }).changes)
            .toEqual([{ field: null, from: '0 3 * * *', to: null }])
        // A flag: its key names the change, `value` is where it went.
        expect(splitChanges({ key: 'analytics', from: false, value: true }))
            .toEqual({ changes: [{ field: 'analytics', from: false, to: true }], fields: [], rest: {} })
        expect(splitChanges({ jobId: 'agg_1', changes: [{ field: 'timeout_secs', from: 10_800, to: 21_600 }] }))
            .toEqual({ changes: [{ field: 'timeout_secs', from: 10_800, to: 21_600 }], fields: [], rest: { jobId: 'agg_1' } })
        expect(splitChanges({ fields: ['displayName', 'graphName'] }))
            .toEqual({ changes: [], fields: ['displayName', 'graphName'], rest: {} })
    })

    it('reads a change of a group of settings as a change of each', () => {
        const { changes } = splitChanges({
            from: { identityProperty: 'urn', nameProperty: 'name' },
            to: { identityProperty: 'qualifiedName', nameProperty: 'name' },
        })
        expect(changes).toEqual([
            { field: 'identityProperty', from: 'urn', to: 'qualifiedName' },
            { field: 'nameProperty', from: 'name', to: 'name' },
        ])
    })

    it('leaves a record that is not a change alone', () => {
        // `changes` as a list of field names (a workspace update) is not a diff.
        const details = { changes: ['name', 'description'], status: 'ok' }
        expect(splitChanges(details)).toEqual({ changes: [], fields: [], rest: details })
    })
})

describe('ActivityDetails', () => {
    it('draws a change as before → after, saying when a side was not set', () => {
        wrap(<ActivityDetails details={{ from: '0 3 * * *', to: null }} />)
        expect(screen.getByText('What changed')).toBeInTheDocument()
        expect(screen.getByText('Before:')).toBeInTheDocument()
        expect(screen.getByText('After:')).toBeInTheDocument()
        expect(screen.getByText('Not set')).toBeInTheDocument()
    })

    it('names each field of a multi-field change, in its units, and marks what stayed', () => {
        wrap(<ActivityDetails details={{
            jobId: 'agg_3f9c0a1b2c3d',
            changes: [
                { field: 'timeout_secs', from: 10_800, to: 21_600 },
                { field: 'scan_width', from: 5_000, to: 5_000 },
            ],
        }} names={{ agg_3f9c0a1b2c3d: 'Nightly ledger run' }} />)
        expect(screen.getByText('What changed · 2')).toBeInTheDocument()
        expect(screen.getByText('Timeout')).toBeInTheDocument()
        expect(screen.getByText('timeout_secs')).toBeInTheDocument()
        expect(screen.getByText('3 h')).toBeInTheDocument()
        expect(screen.getByText('6 h')).toBeInTheDocument()
        expect(screen.getByText('unchanged')).toBeInTheDocument()
        // The rest of the record, labelled, with its id named.
        expect(screen.getByText('Job')).toBeInTheDocument()
        expect(screen.getByText('Nightly ledger run')).toBeInTheDocument()
    })

    it('lists the fields an update set', () => {
        wrap(<ActivityDetails details={{ fields: ['displayName', 'graphName'] }} />)
        expect(screen.getByText('Fields set')).toBeInTheDocument()
        expect(screen.getByText('Display name')).toBeInTheDocument()
        expect(screen.getByText('Graph name')).toBeInTheDocument()
    })

    it('draws nothing for an empty record', () => {
        const { container } = wrap(<ActivityDetails details={{}} />)
        expect(container).toBeEmptyDOMElement()
    })
})
