/**
 * ExportMatchesDialog — every match of the search to a file: the format,
 * the view's own properties as columns (from its exact catalog, by how many
 * entities carry each, any other added by name, never past the server's
 * limit), the export followed to the end with its rows written so far, and
 * the file downloaded from the link its last answer carries.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type {
    SearchCatalogProperty,
    SearchCatalogResult,
    SearchExportRequest,
    SearchExportResult,
    SearchQuery,
} from '@/types/search'

import { ExportMatchesDialog } from '../ExportMatchesDialog'


let state: PropertyCatalogState
let provider: RemoteGraphProvider
const triggerBrowserDownload = vi.fn()

vi.mock('@/hooks/usePropertyCatalog', () => ({
    usePropertyCatalog: () => state,
}))
vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => provider,
}))
vi.mock('@/services/importExportApiService', () => ({
    triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args),
}))


function property(key: string, count: number): SearchCatalogProperty {
    return { key, count, distinct: 1, distinctExact: true, byEntityType: {}, kinds: {}, values: [], residual: 0 }
}

function catalog(properties: SearchCatalogProperty[]): SearchCatalogResult {
    return {
        sessionId: 'c', status: 'complete', stale: false, entities: 1000,
        entityTypes: [], properties, tags: [],
    }
}

const QUERY: SearchQuery = {
    predicate: { kind: 'property', key: 'owner', op: 'eq', value: 'ann' },
    scope: { viewId: 'view-1', scopeMode: 'view' },
}

function answer(over: Partial<SearchExportResult>): SearchExportResult {
    return {
        sessionId: 'exp-1', status: 'running', rows: 0, format: 'csv',
        columns: ['urn', 'displayName', 'entityType', 'qualifiedName'], ...over,
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

function renderDialog(properties = [property('owner', 900), property('gvId', 1000),
                                    property('legacyCode', 12)]) {
    state = {
        catalog: catalog(properties), reading: null, error: null, unavailable: false,
        refresh: vi.fn(),
    }
    const onClose = vi.fn()
    render(<ExportMatchesDialog viewId="view-1" query={QUERY} matchCount={42} onClose={onClose} />)
    return { onClose }
}

const rows = () => within(screen.getByRole('region', { name: 'Columns' }))
    .getAllByRole('checkbox').filter((b) => b.className.includes('font-mono') || b.querySelector('.font-mono'))
const rowNames = () => rows().map((r) => r.querySelector('.font-mono')?.textContent)


beforeEach(() => {
    triggerBrowserDownload.mockReset()
    provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
})


describe('ExportMatchesDialog', () => {
    it("lists the view's properties by how many entities carry them", () => {
        renderDialog()

        expect(rowNames()).toEqual(['gvId', 'owner', 'legacyCode'])
        expect(screen.getByText('on 1,000 of 1,000')).toBeInTheDocument()
        expect(screen.getByText('on 12 of 1,000')).toBeInTheDocument()
    })

    it('exports the chosen columns in the chosen format and downloads the file when it is ready', async () => {
        const user = userEvent.setup()
        const second = deferred<SearchExportResult>()
        const searchExport = vi.spyOn(provider, 'searchExport')
            .mockResolvedValueOnce(answer({ rows: 10, progress: { scanned: 25, total: 100, matched: 10 } }))
            .mockReturnValueOnce(second.promise)
        renderDialog()

        await user.click(screen.getByRole('radio', { name: /NDJSON/ }))
        await user.click(screen.getByRole('checkbox', { name: /Tags/ }))
        await user.click(screen.getByRole('checkbox', { name: /owner/ }))
        await user.click(screen.getByRole('checkbox', { name: /legacyCode/ }))
        await user.click(screen.getByRole('button', { name: /^Export$/ }))

        // Followed with its session; the rows written so far are shown.
        expect(await screen.findByText(/Writing matches — 10 of 42 so far/)).toBeInTheDocument()
        expect(screen.getByText(/Read 25% of the view/)).toBeInTheDocument()
        const bodies = searchExport.mock.calls.map(([body]) => body as SearchExportRequest)
        expect(bodies[0]).toEqual({
            scope: QUERY.scope, predicate: QUERY.predicate, format: 'ndjson',
            columns: ['description', 'owner', 'legacyCode'], waitMs: 2000,
        })
        expect(bodies[1].sessionId).toBe('exp-1')

        await act(async () => second.resolve(answer({
            status: 'complete', rows: 42, format: 'ndjson', downloadToken: 'tok.en',
            filename: 'search-export-20260924.ndjson',
        })))

        expect(await screen.findByText('42 rows exported')).toBeInTheDocument()
        expect(triggerBrowserDownload).toHaveBeenCalledTimes(1)
        const [url, filename] = triggerBrowserDownload.mock.calls[0] as [string, string]
        expect(url).toContain('/api/v1/ws_1/graph/search/exports/exp-1/download?')
        expect(new URL(url, 'http://x').searchParams.get('token')).toBe('tok.en')
        expect(filename).toBe('search-export-20260924.ndjson')

        await user.click(screen.getByRole('button', { name: /Download again/ }))
        expect(triggerBrowserDownload).toHaveBeenCalledTimes(2)
    })

    it("adds a property the catalog doesn't list, by name", async () => {
        const user = userEvent.setup()
        const searchExport = vi.spyOn(provider, 'searchExport')
            .mockResolvedValue(answer({ status: 'complete', downloadToken: 't' }))
        renderDialog()

        await user.type(screen.getByRole('textbox', { name: 'Find a property' }), 'Asset Owner{Enter}')
        expect(screen.getByRole('checkbox', { name: /Asset Owner/ })).toHaveAttribute('aria-checked', 'true')
        await user.click(screen.getByRole('button', { name: /^Export$/ }))

        expect((searchExport.mock.calls[0][0] as SearchExportRequest).columns)
            .toEqual(['description', 'tags', 'Asset Owner'])
    })

    it('never asks for more properties than an export takes', () => {
        const many = Array.from({ length: 150 }, (_, i) => property(`a${String(i).padStart(3, '0')}`, 500))
            .concat(Array.from({ length: 100 }, (_, i) => property(`b${String(i).padStart(3, '0')}`, 10)))
        renderDialog(many)

        // description + tags + the 150 listed, then 48 found by name: 200.
        for (const row of rows()) fireEvent.click(row)
        fireEvent.change(screen.getByRole('textbox', { name: 'Find a property' }), { target: { value: 'b' } })
        // The chosen ones the filter hides stay chosen, out of sight.
        expect(rowNames().every((name) => name?.startsWith('b'))).toBe(true)
        const bs = rows().filter((r) => r.getAttribute('aria-checked') === 'false')
        bs.slice(0, 48).forEach((r) => fireEvent.click(r))

        expect(screen.getByText('200 properties — the most an export takes')).toBeInTheDocument()
        const rest = rows().filter((r) => r.getAttribute('aria-checked') === 'false')
        expect(rest).toHaveLength(52)
        expect(rest.every((r) => (r as HTMLButtonElement).disabled)).toBe(true)
    })

    it('says why an export was refused, and can try again', async () => {
        const user = userEvent.setup()
        const refused = Object.assign(
            new Error('API Error 400: {"detail":"A path search finds routes, not entities to export."}'),
            { status: 400 })
        vi.spyOn(provider, 'searchExport').mockRejectedValue(refused)
        renderDialog()

        await user.click(screen.getByRole('button', { name: /^Export$/ }))

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'A path search finds routes, not entities to export.')
        expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
        expect(triggerBrowserDownload).not.toHaveBeenCalled()
    })

    it('explains a refusal in words, not a status code', async () => {
        const user = userEvent.setup()
        vi.spyOn(provider, 'searchExport').mockRejectedValue(
            Object.assign(new Error('API Error 403: {}'), { status: 403 }))
        renderDialog()

        await user.click(screen.getByRole('button', { name: /^Export$/ }))

        expect(await screen.findByRole('alert')).toHaveTextContent(
            "You can't export matches from this view.")
    })
})
