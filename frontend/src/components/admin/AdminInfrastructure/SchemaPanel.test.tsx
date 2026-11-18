/**
 * The "Database schema" panel on Admin → Infrastructure: whether anything needs doing, what an
 * upgrade with this build would do (placement and the migrations, in order), warnings, built-in
 * grants a database doesn't have, and what upgrades have done.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

// Each test sets the response it needs. (A beforeEach mockReset makes Vitest report the rejected
// response of the failure case as the test's own error.)
const { getSchema } = vi.hoisted(() => ({ getSchema: vi.fn() }))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, getSchema } }
})

import { SchemaPanel, schemaHeadline } from './SchemaPanel'
import type { SchemaStatus } from '@/services/systemStatusService'

const HEAD = '20261119_1400_merge_ps_build'

function status(over: Partial<SchemaStatus> = {}, plan: Partial<SchemaStatus['plan']> = {}): SchemaStatus {
    return {
        generatedAt: new Date().toISOString(),
        applied: [HEAD], expected: [HEAD], atHead: true,
        build: { from: 'main at abc123', onMain: true, version: '0.2.0' },
        plan: { verdict: 'up_to_date', reason: "At this build's head: nothing to run.", heads: [HEAD], stamps: [HEAD],
                placement: null, wouldRun: [], warnings: [], ...plan },
        history: [{ id: 2, revision: HEAD, kind: 'stamped', at: new Date().toISOString(), build: 'main@abc123', detail: null }],
        lastSeeded: null,
        ...over,
    }
}

function renderPanel() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><SchemaPanel /></QueryClientProvider>)
}

describe('SchemaPanel', () => {
    it('says the database is up to date, against what, from which build, and what upgrades did', async () => {
        getSchema.mockResolvedValue(status())
        renderPanel()
        expect(await screen.findByText('Up to date')).toBeInTheDocument()
        expect(screen.getByText('main at abc123')).toBeInTheDocument()
        expect(screen.getByText(/nothing to run/)).toBeInTheDocument()
        expect(screen.getByText('What upgrades have done')).toBeInTheDocument()
        expect(screen.getByText('stamped')).toBeInTheDocument()
    })

    it('shows where another build’s stamp would be placed and the migrations an upgrade would run', async () => {
        const pending = Array.from({ length: 11 }, (_, i) => `rev_${i}`)
        getSchema.mockResolvedValue(status({ applied: ['20261116_1200_graph_watch'], atHead: false }, {
            verdict: 'upgrade', reason: '11 migration(s) to run.', wouldRun: pending,
            placement: { foreign: ['20261116_1200_graph_watch'], stamps: ['20261113_1400_gv_ps_candidate'],
                         how: 'exactly, from the lineage other lines recorded' },
        }))
        renderPanel()
        expect(await screen.findByText('11 migrations pending')).toBeInTheDocument()
        expect(screen.getByText(/exactly, from the lineage other lines recorded/)).toBeInTheDocument()
        expect(screen.getByText('rev_7')).toBeInTheDocument()
        expect(screen.queryByText('rev_10')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Show all 11' }))
        expect(screen.getByText('rev_10')).toBeInTheDocument()
    })

    it('says when an upgrade would refuse, with warnings and the built-in grants a database lacks', async () => {
        getSchema.mockResolvedValue(status({
            lastSeeded: { id: 9, revision: HEAD, kind: 'seeded', at: null, build: null,
                          detail: { notGranted: ['org_auditor:system:audit:read'] } },
        }, {
            verdict: 'refused', reason: "alembic_version names ['x'], which this build doesn't have. Nothing was changed.",
            warnings: ['Migration y has changed since it ran on this database; the change won’t reach it.'],
        }))
        renderPanel()
        expect(await screen.findByText('Needs attention')).toBeInTheDocument()
        expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument()
        expect(screen.getByText(/has changed since it ran/)).toBeInTheDocument()
        expect(screen.getByText('org_auditor:system:audit:read')).toBeInTheDocument()
    })

    it('says when the schema couldn’t be read', async () => {
        getSchema.mockImplementation(() => Promise.reject(new Error("The database couldn't be read")))
        renderPanel()
        expect(await screen.findByText(/Couldn’t read the schema/)).toBeInTheDocument()
    })

    it('headlines warnings even when up to date', () => {
        expect(schemaHeadline(status({}, { warnings: ['w'] }))).toEqual({ label: 'Up to date, with warnings', tone: 'warn' })
        expect(schemaHeadline(status({}, { verdict: 'fresh_install' })).label).toBe('Not installed')
    })
})
