/**
 * What an event recorded, as what changed: one setting as before → after, a
 * group of settings as a before → after each, the fields an update set, and
 * the rest as labelled values — with the ids in it named.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { ActivityDetails, splitBulkEdits, splitChanges } from '../ActivityDetails'

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

describe('a publish that took bulk property edits to Published', () => {
    const published = {
        commitId: 'cmt_9',
        changes: { create: 0, update: 27_110, delete: 0 },
        propertyJobs: {
            total: 3,
            jobs: [
                { jobId: 'vjob_1', label: 'Rename owner → steward', changed: 27_000, refused: 4, actor: 'usr_ana',
                  message: 'Steward is the new name', status: 'completed' },
                { jobId: 'vjob_2', op: { kind: 'convert', key: 'tier', toKind: 'Integer' }, changed: 1, refused: 0, partial: true },
            ],
        },
    }

    it('takes them out of the rest of the record', () => {
        const { edits, total, rest } = splitBulkEdits(published)
        expect(total).toBe(3)
        expect(edits.map((e) => [e.label, e.changed, e.partial])).toEqual([
            ['Rename owner → steward', 27_000, false], ['Convert tier to Integer', 1, true]])
        expect(rest).toEqual({ commitId: 'cmt_9', changes: published.changes })
        expect(splitBulkEdits({ propertyJobs: { jobs: 'x' } }).edits).toEqual([])
    })

    it('lists each: what it did, to how many, who ran it and why', () => {
        wrap(<ActivityDetails details={published} names={{ usr_ana: 'Ana Ruiz' }} />)
        expect(screen.getByText('Bulk property edits · 3')).toBeInTheDocument()
        expect(screen.getByText('Rename owner → steward')).toBeInTheDocument()
        // Who ran it is drawn as the person (their chip).
        expect(screen.getByText('Rename owner → steward').closest('li')).toHaveTextContent(
            /27,000 entities changed in the draft · 4 not changed· by/)
        expect(screen.getByText('“Steward is the new name”')).toBeInTheDocument()
        expect(screen.getByText('in part')).toBeInTheDocument()
        expect(screen.getByText('and 1 more')).toBeInTheDocument()
    })
})
