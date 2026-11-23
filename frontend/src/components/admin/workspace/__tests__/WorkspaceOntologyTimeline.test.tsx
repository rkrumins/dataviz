/**
 * What changed in the data model: one card per semantic layer (two sources on one layer are one
 * card, its history read once), each change titled with its version and who made it, its type
 * changes as Things / Connections chips, the latest five then "Show earlier", and the empty states.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { OntologyAuditEntry, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

const audit = vi.hoisted(() => vi.fn())
vi.mock('@/services/ontologyDefinitionService', async (orig) => {
    const real = await orig<typeof import('@/services/ontologyDefinitionService')>()
    return { ...real, ontologyDefinitionService: { ...real.ontologyDefinitionService, auditLog: audit } }
})
vi.mock('@/services/userDirectoryService', async (orig) => ({
    ...(await orig<typeof import('@/services/userDirectoryService')>()),
    peopleById: vi.fn(async (ids: string[]) => ids.filter(id => id === 'usr_ada')
        .map(id => ({ id, displayName: 'Ada Okafor', email: 'ada@example.com', deleted: false }))),
}))

import { WorkspaceOntologyTimeline } from '../WorkspaceOntologyTimeline'

const source = (id: string, label: string, ontologyId?: string) => ({ id, label, ontologyId }) as DataSourceResponse
const layer = (id: string, name: string, isPublished: boolean, entities: string[] = [], rels: string[] = []) => ({
    id, name, version: 4, isPublished, updatedAt: '2026-11-01T10:00:00Z',
    entityTypeDefinitions: Object.fromEntries(entities.map(e => [e, {}])),
    relationshipTypeDefinitions: Object.fromEntries(rels.map(r => [r, {}])),
}) as unknown as OntologyDefinitionResponse
let n = 0
const entry = (action: OntologyAuditEntry['action'], version: number, extra: Partial<OntologyAuditEntry> = {}): OntologyAuditEntry => ({
    id: `e${++n}`, ontologyId: 'ont_fin', schemaId: 'fin', action, actor: 'usr_ada', version, summary: null, changes: null,
    createdAt: new Date(Date.now() - n * 3_600_000).toISOString(), ...extra,
})

const LAYERS = {
    ont_fin: layer('ont_fin', 'Finance Lineage', true, ['Ledger', 'Account', 'Report'], ['FEEDS']),
    ont_reg: layer('ont_reg', 'Regulatory Returns', false),
}

function renderIt(dataSources: DataSourceResponse[], ontologyMap: Record<string, OntologyDefinitionResponse> = LAYERS) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <MemoryRouter><WorkspaceOntologyTimeline dataSources={dataSources} ontologyMap={ontologyMap} /></MemoryRouter>
        </QueryClientProvider>,
    )
}

const card = (name: string) => screen.findByRole('article', { name })
const changes = (name: string) => within(screen.getByRole('list', { name: `Changes to ${name}` })).getAllByRole('listitem')

beforeEach(() => {
    audit.mockReset()
    n = 0
})

describe('WorkspaceOntologyTimeline', () => {
    it('gives each semantic layer one card, listing every source that uses it, and reads its history once', async () => {
        audit.mockResolvedValue([])
        renderIt([
            source('ds_gl', 'General Ledger', 'ont_fin'), source('ds_risk', 'Risk Models', 'ont_fin'),
            source('ds_reg', 'Regulatory Reporting', 'ont_reg'), source('ds_raw', 'Raw files'),
        ])

        const fin = await card('Finance Lineage')
        expect(screen.getAllByRole('article')).toHaveLength(2)
        expect(within(fin).getByText('General Ledger')).toBeInTheDocument()
        expect(within(fin).getByText('Risk Models')).toBeInTheDocument()
        expect(within(fin).getByText('Published')).toBeInTheDocument()
        expect(within(fin).getByRole('link', { name: /Open in Semantic Layers/ })).toHaveAttribute('href', '/schema/ont_fin')
        // Its kinds of thing and of connection, counted from the layer.
        expect(within(fin).getByText('Kinds of thing').closest('div')).toHaveTextContent('3')
        expect(within(fin).getByText('Kinds of connection').closest('div')).toHaveTextContent('1')

        const reg = await card('Regulatory Returns')
        expect(within(reg).getByText('Regulatory Reporting')).toBeInTheDocument()
        expect(within(reg).getByText('Draft')).toBeInTheDocument()
        expect(screen.queryByText('Raw files')).toBeNull()

        expect(audit).toHaveBeenCalledTimes(2)
        expect(audit.mock.calls.map(c => c[0]).sort()).toEqual(['ont_fin', 'ont_reg'])
    })

    it('titles each change, names who made it, and shows its type changes as Things and Connections', async () => {
        audit.mockResolvedValue([
            entry('published', 4, { summary: 'Published v4' }),
            entry('updated', 4, {
                summary: 'Added 1 entity type(s); Removed 1 relationship(s)',
                changes: { addedEntityTypes: ['Counterparty'], removedRelationshipTypes: ['LINKED_TO'] },
            }),
            entry('created', 1, { actor: null, summary: 'Created draft v1 with 3 entity types, 1 relationships' }),
        ])
        renderIt([source('ds_gl', 'General Ledger', 'ont_fin')])

        await card('Finance Lineage')
        const [published, edited, created] = changes('Finance Lineage')
        expect(within(published).getByText('Published v4')).toBeInTheDocument()
        expect(await within(published).findByText('Ada Okafor')).toBeInTheDocument()
        // A summary that only repeats the title is not shown twice.
        expect(within(published).getAllByText('Published v4')).toHaveLength(1)

        expect(within(edited).getByText('Edited v4')).toBeInTheDocument()
        const things = within(edited).getByText('Things').parentElement!
        expect(things).toHaveTextContent('Added Counterparty')
        const connections = within(edited).getByText('Connections').parentElement!
        expect(connections).toHaveTextContent('Removed LINKED_TO')
        // The chips say it in plain words; the technical summary is left out.
        expect(within(edited).queryByText(/entity type\(s\)/)).toBeNull()

        expect(within(created).getByText('Created v1')).toBeInTheDocument()
        expect(within(created).getByText('System')).toBeInTheDocument()
        expect(within(created).getByText('Created draft v1 with 3 entity types, 1 relationships')).toBeInTheDocument()
    })

    it('shows the latest five changes, then the earlier ones on request', async () => {
        const user = userEvent.setup()
        audit.mockResolvedValue([8, 7, 6, 5, 4, 3, 2, 1].map(v => entry('published', v)))
        renderIt([source('ds_gl', 'General Ledger', 'ont_fin')])

        await card('Finance Lineage')
        expect(changes('Finance Lineage')).toHaveLength(5)
        await user.click(screen.getByRole('button', { name: 'Show 3 earlier changes' }))
        expect(changes('Finance Lineage')).toHaveLength(8)
        expect(screen.queryByRole('button', { name: /earlier change/ })).toBeNull()
    })

    it('narrows to published changes', async () => {
        const user = userEvent.setup()
        audit.mockResolvedValue([entry('updated', 5), entry('published', 4), entry('cloned', 4)])
        renderIt([source('ds_gl', 'General Ledger', 'ont_fin')])

        await card('Finance Lineage')
        expect(changes('Finance Lineage')).toHaveLength(3)
        await user.click(screen.getByRole('radio', { name: 'Published only' }))
        expect(changes('Finance Lineage')).toHaveLength(1)
        expect(screen.getByText('Published v4')).toBeInTheDocument()
    })

    it('says what to do when no source has a semantic layer, and asks for nothing', () => {
        renderIt([source('ds_raw', 'Raw files')])
        expect(screen.getByText('No semantic layer yet')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Open Semantic Layers/ })).toHaveAttribute('href', '/schema')
        expect(screen.queryByRole('radiogroup')).toBeNull()
        expect(audit).not.toHaveBeenCalled()
    })

    it('says so quietly when a layer has no changes recorded', async () => {
        audit.mockResolvedValue([])
        renderIt([source('ds_gl', 'General Ledger', 'ont_fin')])
        expect(within(await card('Finance Lineage')).getByText('No changes recorded yet.')).toBeInTheDocument()
    })

    it('shows the cards’ shape while the history loads', () => {
        audit.mockReturnValue(new Promise(() => {}))
        renderIt([source('ds_gl', 'General Ledger', 'ont_fin')])
        expect(screen.getByLabelText('Loading what changed')).toHaveAttribute('aria-busy', 'true')
    })
})
