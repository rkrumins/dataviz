/**
 * The identifier each thing in a file is given, settled before an import into the Playground:
 *   - a things CSV's identifier column is guessed from its name, and any other may be chosen —
 *     its things read again by it, the old key kept as a property, its rows checked again;
 *   - the step shows the first values and counts the things with none and the values shared, and
 *     Import waits until every thing has one and no two share one;
 *   - a standard file's node rows give their urn, else their id; rows that give neither may take
 *     one from a column — as their urn — and the file goes up rewritten;
 *   - a file the server reads is checked there, and the step says so;
 *   - outside the Playground, nothing of this is asked.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  importInParts: vi.fn(),
  getImportSettings: vi.fn(),
  pollJob: vi.fn(),
}))

import { getImportSettings, importInParts, pollJob, type ImportSettings } from '@/services/importExportApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import { ImportDialog } from '../ImportDialog'
import { readFiles, withIdentifierColumn } from '../fileRows'
import { checkIdentifiers } from '../identifierCheck'

const csv = (name: string, body: string) => new File([body], name, { type: 'text/csv' })
const THINGS = ['id,type,name,owner', 'o1,Table,Orders,Data', 'd1,Table,Daily,', ',Dashboard,Sales,Finance', 'd1,Report,Weekly,'].join('\n')

describe('checking identifiers', () => {
  it('reads a things CSV’s by the column its name says, and counts the blank and the shared', async () => {
    const read = await readFiles([csv('things.csv', 'key,type,name\na,T,A\nb,T,B\nb,T,B2\n,T,C\n')])
    expect(checkIdentifiers(read)).toEqual({
      from: 'column', column: 'key', columns: ['key', 'name'], total: 4, blank: 1,
      duplicates: [{ value: 'b', count: 2 }], sample: ['a', 'b', 'b'], ok: false,
    })
  })

  it('reads them again by another column: the old key becomes a property, the rows checked again', async () => {
    const read = await readFiles([csv('things.csv', 'key,type,name,sap\na,T,A,S1\n,T,B,S2\n')])
    expect(read.errors.map(e => e.message)).toEqual(['Needs a key'])
    const bySap = withIdentifierColumn(read, 'sap')
    expect(bySap.things.map(t => [t.key, t.properties])).toEqual([['S1', { key: 'a' }], ['S2', undefined]])
    expect(bySap.errors).toEqual([])
    expect(checkIdentifiers(bySap)).toMatchObject({ column: 'sap', blank: 0, ok: true })
    expect(withIdentifierColumn(read, 'nope')).toBe(read)
  })

  it('reads a standard file’s urn, else its id; and keeps its records only when a row gives neither', async () => {
    const all = await readFiles([csv('import.csv', 'kind,urn,entityType,prop.id\nnode,urn:a,T,\nnode,,T,b\n')])
    expect(all.identifiers).toEqual(['urn:a', 'b'])
    expect(all.things.map(t => t.key)).toEqual(['urn:a', 'b'])          // named by its id, with no urn
    expect(all.records).toBeUndefined()
    expect(checkIdentifiers(all)).toMatchObject({ from: 'standard', ok: true, columns: [] })

    const some = await readFiles([csv('import.csv', 'kind,urn,entityType,qualifiedName,prop.code\nnode,urn:a,T,db.a,\nnode,,T,db.b,B-1\nedge,,,,\n')])
    expect(some.identifiers).toEqual(['urn:a', ''])
    expect(checkIdentifiers(some)).toMatchObject({ blank: 1, ok: false, columns: ['qualifiedName', 'prop.code'] })
  })

  it('gives a standard file’s rows without one an identifier from a column, as their urn, and rewrites the file', async () => {
    const read = await readFiles([csv('import.csv', 'kind,urn,entityType,prop.code\nnode,urn:a,T,A-1\nnode,,T,B-1\n')])
    const mapped = withIdentifierColumn(read, 'prop.code')
    expect(mapped.identifiers).toEqual(['urn:a', 'urn:playground:B-1'])
    expect(checkIdentifiers(mapped, 'prop.code')).toMatchObject({ column: 'prop.code', blank: 0, ok: true })
    expect(mapped.passthroughFormat).toBe('ndjson')
    const sent = (await mapped.passthrough!.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(sent).toEqual([
      { kind: 'node', urn: 'urn:a', entityType: 'T', 'prop.code': 'A-1' },
      { kind: 'node', urn: 'urn:playground:B-1', entityType: 'T', 'prop.code': 'B-1' },
    ])
  })
})

const settings = { identifier: 'urn', replaceMinLive: 1000, replaceDeleteFraction: 0.5, replaceCreateFraction: 0.5,
  replaceMinMatchFraction: 0.05 }

function open(wsId = 'ws_play') {
  const view = render(<ImportDialog wsId={wsId} graphId="g1" onClose={() => {}} />)
  return view.container.querySelector('input[type="file"]') as HTMLInputElement
}

beforeEach(() => {
  vi.mocked(importInParts).mockReset().mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
  vi.mocked(pollJob).mockReset().mockReturnValue(new Promise(() => {}))
  vi.mocked(getImportSettings).mockReset().mockResolvedValue({
    dataSourceId: 'ds1', overrides: {}, platform: settings, effective: { ...settings, sources: {} },
    replaceGuard: true, followsParent: false, maxMatchingProperties: 10, matchingProperties: [],
  } as unknown as ImportSettings)
  useWorkspacesStore.setState({ workspaces: [
    { id: 'ws_play', name: 'Playground', kind: 'playground', dataSources: [] },
    { id: 'ws_team', name: 'Team', kind: 'standard', dataSources: [] },
  ] as never })
})

describe('Import into a Playground graph', () => {
  it('shows what identifies each thing, and waits until every thing has one of its own', async () => {
    await userEvent.upload(open(), csv('things.csv', THINGS))
    const step = await screen.findByRole('group', { name: 'What identifies each thing' })
    expect(within(step).getByLabelText('Read from the column')).toHaveValue('id')
    expect(within(step).getByText('Guessed')).toBeInTheDocument()
    expect(within(step).getByRole('list', { name: 'First identifiers' })).toHaveTextContent('o1d1d1')
    expect(step).toHaveTextContent('1with none')
    expect(step).toHaveTextContent('1value shared')
    expect(step).toHaveTextContent('To fix')
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()

    // Identified by their names instead — each unique — it may go.
    await userEvent.selectOptions(within(step).getByLabelText('Read from the column'), 'name')
    expect(step).toHaveTextContent('Ready')
    expect(within(step).queryByText('Guessed')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    await waitFor(() => expect(importInParts).toHaveBeenCalled())
    const rows = (await vi.mocked(importInParts).mock.calls[0][2].text()).trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => r.urn)).toEqual(['urn:playground:Orders', 'urn:playground:Daily', 'urn:playground:Sales', 'urn:playground:Weekly'])
    // Its old `id`s would name other things: they aren't sent.
    expect(rows[0]).toEqual({ kind: 'node', urn: 'urn:playground:Orders', entityType: 'Table', displayName: 'Orders', 'prop.owner': 'Data' })
  })

  it('asks for the column when no name says which identifies a thing', async () => {
    await userEvent.upload(open(), csv('things.csv', 'code,type,name\nA,T,a\nB,T,b\n'))
    const step = await screen.findByRole('group', { name: 'What identifies each thing' })
    const column = within(step).getByLabelText('Read from the column')
    expect(column).toHaveValue('')
    expect(within(column).getByRole('option', { name: 'Choose a column…' })).toBeInTheDocument()
    expect(step).toHaveTextContent('2with none')
    await userEvent.selectOptions(column, 'code')
    expect(step).toHaveTextContent('Ready')
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeEnabled()
  })

  it('maps a column onto a standard file’s rows that give no urn or id', async () => {
    await userEvent.upload(open(), csv('import.csv', 'kind,urn,entityType,displayName,prop.code\nnode,urn:a,T,A,A-1\nnode,,T,B,B-1\n'))
    const step = await screen.findByRole('group', { name: 'What identifies each thing' })
    expect(step).toHaveTextContent('1with none')
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()
    await userEvent.selectOptions(within(step).getByLabelText('Rows without a urn or id take one from'), 'prop.code')
    expect(step).toHaveTextContent('Ready')
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    await waitFor(() => expect(importInParts).toHaveBeenCalled())
    const [, , sent, opts] = vi.mocked(importInParts).mock.calls[0]
    expect(opts).toMatchObject({ format: 'ndjson' })
    expect((await sent.text())).toContain('"urn":"urn:playground:B-1"')
  })

  it('leaves a file the server reads to the server, and says so', async () => {
    await userEvent.upload(open(), new File(['PK'], 'graph.xlsx'))
    expect(await screen.findByText(/read on the server as it loads/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeEnabled()
  })

  it('asks nothing of it outside the Playground', async () => {
    await userEvent.upload(open('ws_team'), csv('things.csv', THINGS))
    await screen.findByRole('note', { name: 'What the import reads' })
    expect(screen.queryByRole('group', { name: 'What identifies each thing' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeEnabled()
  })
})
