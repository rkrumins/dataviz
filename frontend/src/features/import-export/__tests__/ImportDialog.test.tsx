/**
 * ImportDialog pins:
 *   - a file larger than one import can take is refused before any upload, saying how to split it:
 *     10 GB for a file read a row at a time, 100 MB for a JSON or Excel file (read whole);
 *   - while the file uploads, the dialog says how much of it is up;
 *   - an import job that failed or was cancelled on the server ends as a failure that says why,
 *     never as a finished import;
 *   - an import queued for the server's workers says it is waiting, and how many are ahead of it;
 *   - a running import says how far it has got, and that it resumed when a server took it over;
 *   - closing the dialog stops following the import (it carries on on the server);
 *   - the preview says why a row was refused, and shows a note on a row that applied;
 *   - it matches existing items by the graph's default (sending none: the server applies it) unless
 *     you choose another; a property must be named, and one no import matched by yet says it is
 *     indexed first; a fork whose parent's default is a property says it matches by Entity ID;
 *   - a replace the replace guard refused can be replaced anyway, into the draft its rows are on.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  importInParts: vi.fn(),
  getImport: vi.fn(),
  getImportSettings: vi.fn(),
  getImportPreview: vi.fn(),
  pollJob: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))

import {
  getImportPreview, getImportSettings, importInParts, pollJob, triggerBrowserDownload, type ImportSettings,
} from '@/services/importExportApiService'
import { ImportDialog } from '../ImportDialog'

let unmount = () => {}

function open() {
  const view = render(<ImportDialog wsId="ws1" graphId="g1" onClose={() => {}} />)
  unmount = view.unmount
  return view.container.querySelector('input[type="file"]') as HTMLInputElement
}

function file(name: string, size: number, content = 'kind,urn\n'): File {
  const f = new File([content], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const values = { identifier: 'urn', replaceMinLive: 1000, replaceDeleteFraction: 0.5,
  replaceCreateFraction: 0.5, replaceMinMatchFraction: 0.05 }

beforeEach(() => {
  vi.mocked(importInParts).mockReset()
  vi.mocked(pollJob).mockReset()
  vi.mocked(getImportSettings).mockReset().mockResolvedValue({
    dataSourceId: 'ds1', overrides: { ...values, replaceMinLive: null, replaceDeleteFraction: null,
      replaceCreateFraction: null, replaceMinMatchFraction: null },
    platform: { ...values, identifier: 'entity_id' }, effective: { ...values, sources: {} },
    replaceGuard: true, followsParent: false, maxMatchingProperties: 10,
    matchingProperties: [{ name: 'external_id', status: 'ready', seq: 4, current: true, createdAt: 't' }],
  } as unknown as ImportSettings)
})

describe('ImportDialog', () => {
  it('downloads the starter template as Excel, or as CSV or NDJSON', async () => {
    open()
    await userEvent.click(screen.getByRole('button', { name: /Download a starter template/ }))
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }))
    await userEvent.click(screen.getByRole('button', { name: 'NDJSON' }))
    expect(vi.mocked(triggerBrowserDownload).mock.calls).toEqual([
      [expect.stringMatching(/\/graphs\/g1\/imports\/template\?format=xlsx$/), 'import-template.xlsx'],
      [expect.stringMatching(/format=csv$/), 'import-template.csv'],
      [expect.stringMatching(/format=ndjson$/), 'import-template.ndjson'],
    ])
  })

  it('refuses a file over the upload limit before sending it', async () => {
    await userEvent.upload(open(), file('graph.csv', 10.5 * 1024 ** 3))

    expect(await screen.findByText(/This file is 10\.5 GB, and one import can be at most 10\.0 GB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()
    expect(importInParts).not.toHaveBeenCalled()
  })

  it('takes a multi-GB CSV, but refuses a JSON file it would have to read whole', async () => {
    await userEvent.upload(open(), file('graph.csv', 4.2 * 1024 ** 3))
    expect(await screen.findByRole('button', { name: /^Import$/ })).toBeEnabled()

    await userEvent.upload(open(), file('graph.json', 150 * 1024 ** 2, '[{"kind":"node"}]'))
    expect(await screen.findByText(/A JSON file is read whole, so one import of it can be at most 100\.0 MB/))
      .toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Import$/ }).at(-1)).toBeDisabled()
  })

  it('says how much of the file is up while it uploads', async () => {
    vi.mocked(importInParts).mockImplementation(async (_ws, _g, _file, opts) => {
      opts?.onProgress?.(512 * 1024, 2 * 1024 * 1024)
      return new Promise(() => {})   // still uploading
    })
    await userEvent.upload(open(), file('graph.csv', 2 * 1024 * 1024))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText('Uploading… 512.0 KB of 2.0 MB')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  })

  it.each([
    ['failed', 'The job stopped before it finished. Start it again.', /The job stopped before it finished/],
    ['cancelled', null, /The import was cancelled/],
  ] as const)('ends a %s job as a failure that says why', async (status, message, shown) => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'running' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status, errorMessage: message } as Job)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText(shown)).toBeInTheDocument()
    expect(screen.queryByText('Import another')).not.toBeInTheDocument()
  })

  it('says when the import waits its turn, and how many are ahead of it', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockImplementation(async (_fetcher, opts) => {
      opts?.onTick?.({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'pending', queuedAhead: 2 } as Job)
      return new Promise<Job>(() => {})   // still waiting
    })
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText('Waiting to start…')).toBeInTheDocument()
    expect(screen.getByText('2 jobs are ahead of it.')).toBeInTheDocument()
  })

  it('says how far a running import has got, and that it resumed; closed, it stops following it', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockImplementation(async (_fetcher, opts) => {
      opts?.onTick?.({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'running', phase: 'nodes',
        processed: 4000, total: 10000, attempt: 2 } as Job)
      return new Promise<Job>(() => {})   // still running
    })
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText('Applying the changes… 4,000 of 10,000 rows')).toBeInTheDocument()
    expect(screen.getByText('Resumed where it left off (attempt 2).')).toBeInTheDocument()
    // It cannot be closed while it runs, so it never says to carry on working elsewhere.
    expect(screen.queryByText(/keep working/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Keep this open until it finishes/)).toBeInTheDocument()
    const signal = vi.mocked(pollJob).mock.calls[0][1]!.signal!
    unmount()
    await waitFor(() => expect(signal.aborted).toBe(true))
  })

  it('says the staged changes show on the canvas once it closes, not that they already do', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'completed',
      summary: { new: 3, updated: 1, deleted: 0, invalid: 0 } } as Job)
    vi.mocked(getImportPreview).mockResolvedValue({ sample: [] } as never)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText('4 changes ready to review')).toBeInTheDocument()
    expect(screen.queryByText(/already visible/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Matched existing items by/)).not.toBeInTheDocument()   // an older server
    expect(screen.getByText(/when this closes/i)).toBeInTheDocument()
  })

  it('says why a row was refused, and shows a note on a row that applied', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'completed',
      identifier: 'prop.external_id', summary: { new: 0, updated: 1, deleted: 0, invalid: 1 } } as Job)
    vi.mocked(getImportPreview).mockResolvedValue({ sample: [
      { rowIndex: 0, kind: 'node', status: 'updated', label: 'orders',
        reasons: ["urn 'urn:li:renamed' isn't stored: an import never changes a node's urn"] },
      { rowIndex: 1, kind: 'node', status: 'invalid', label: 'revenue',
        reasons: ['changed since you exported it: description'] },
    ] } as never)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText(/urn 'urn:li:renamed' isn't stored/)).toBeInTheDocument()
    expect(screen.getByText('changed since you exported it: description')).toBeInTheDocument()
    expect(screen.getByText(/Matched existing items by Property external_id/)).toBeInTheDocument()
  })

  it('matches existing items by the graph’s default unless you choose another', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    const urn = await screen.findByRole('radio', { name: /URN · default/ })
    expect(urn).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ identifier: undefined, allowMassDelete: false })
  })

  it('on a fork whose parent matches by a property, matches by Entity ID and says why', async () => {
    const base = await vi.mocked(getImportSettings)('ws1', 'g1')
    vi.mocked(getImportSettings).mockResolvedValue({
      ...base, followsParent: true, overrides: { ...base.overrides, identifier: 'prop.external_id' },
      effective: { ...values, identifier: 'entity_id', sources: { identifier: 'fork' } },
    } as unknown as ImportSettings)
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    expect(await screen.findByRole('radio', { name: /Entity ID · default/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/its parent’s default is a property, and a fork can’t match by one yet/))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ identifier: undefined })
  })

  it('matches by a property once it is named, and says one no import matched by yet is indexed first', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(await screen.findByRole('radio', { name: /A property/ }))
    expect(screen.getByText('Name the property its rows are matched by.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Property name'), 'sap_id')
    expect(screen.getByText(/No import has matched by sap_id yet: this one indexes it first/)).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Property name'))
    await userEvent.type(screen.getByLabelText('Property name'), 'external_id')
    expect(screen.queryByText(/No import has matched by/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ identifier: 'prop.external_id' })
  })

  it('finds rows without the property by their urn, and replaces only what holds it, when asked', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(await screen.findByRole('button', { name: /Replace \(authoritative\)/ }))
    await userEvent.click(screen.getByRole('radio', { name: /A property/ }))
    await userEvent.type(screen.getByLabelText('Property name'), 'external_id')
    await userEvent.click(screen.getByRole('checkbox', { name: /Rows without it: find them by their urn/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Delete only items that have this property/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({
      identifier: 'prop.external_id,urn', reconcileMode: 'replace', replaceScope: 'keyed' })
  })

  it('replaces anyway, into the draft its rows are on, once the replace guard refused it', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br_9', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValueOnce({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      branchId: 'br_9', errorMessage: 'Nothing was deleted: this replace would delete 900 of the 1,000 entities',
      summary: { new: 900, updated: 0, unchanged: 100, deleted: 0, invalid: 0,
        failure: { code: 'mass_delete_blocked', action: 'allow_mass_delete' } } } as Job)
      .mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByText('Replace (authoritative)'))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(await screen.findByText(/would delete 900 of the 1,000/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Replace anyway/ }))
    expect(vi.mocked(importInParts).mock.calls[1][3]).toMatchObject({
      reconcileMode: 'replace', branchId: 'br_9', allowMassDelete: true })
  })

  it('offers to find the rows a property alone refused by their urn, and imports again into its draft', async () => {
    const refused = { total: 3, byCode: { no_key: 1, two_entities: 2 }, hints: { by_urn: 3 }, fixes: {}, rows: [] }
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br_9', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValueOnce({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      branchId: 'br_9', identifier: 'prop.MY_UNIQUE_ID', errorMessage: 'Nothing was deleted: 3 node row(s) of the file were refused',
      summary: { new: 1, updated: 0, unchanged: 0, deleted: 0, invalid: 3, refused,
        failure: { code: 'rows_refused', action: 'fix_rows' } } } as unknown as Job)
      .mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByText('Replace (authoritative)'))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(await screen.findByText(/3 of these rows\s+would be found by their urn/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Find them by their urn/ }))
    expect(vi.mocked(importInParts).mock.calls[1][3]).toMatchObject({
      reconcileMode: 'replace', branchId: 'br_9', identifier: 'prop.MY_UNIQUE_ID,urn', allowMassDelete: false })
    expect(vi.mocked(importInParts).mock.calls[1][3]?.maxRefusedRows).toBeUndefined()
  })

  it('says which rows a held replace refused and why, and imports the rest anyway into its draft', async () => {
    const refused = { total: 10, byCode: { no_key: 7, invalid_type: 3 },
      fixes: { no_key: 'Give the row a key its identifier finds it by.', invalid_type: 'Use a type the ontology defines.' }, rows: [
      { rowIndex: 4, kind: 'node', label: 'orders', code: 'no_key', reason: 'give it a urn' },
      { rowIndex: 9, kind: 'node', label: 'sales', code: 'invalid_type', reason: "Dashboard isn't a type here" }] }
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br_9', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValueOnce({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      branchId: 'br_9', errorMessage: 'Nothing was deleted: 10 row(s) of the file were refused',
      summary: { new: 3, updated: 0, unchanged: 90, deleted: 0, invalid: 10, refused,
        failure: { code: 'rows_refused', action: 'fix_rows' } } } as Job)
      .mockReturnValue(new Promise<Job>(() => {}))
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByText('Replace (authoritative)'))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(await screen.findByRole('heading', { name: '10 rows refused' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /7 no_key/ })).toBeInTheDocument()
    expect(screen.getByText(/Dashboard isn't a type here/)).toBeInTheDocument()
    expect(screen.getByText(/Give the row a key its identifier finds it by/)).toBeInTheDocument()
    expect(screen.getByText(/Use a type the ontology defines/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replace anyway/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Import the rest anyway/ }))
    expect(vi.mocked(importInParts).mock.calls[1][3]).toMatchObject({
      reconcileMode: 'replace', branchId: 'br_9', maxRefusedRows: '-1', allowMassDelete: false })
  })

  it('says which rows a completed import refused, and why', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'completed',
      branchId: 'br1', summary: { new: 2, updated: 0, unchanged: 0, deleted: 0, invalid: 1, refused: {
        total: 1, byCode: { no_key: 1 }, rows: [
          { rowIndex: 2, kind: 'node', label: '', code: 'no_key', reason: 'give it a urn' }] } } } as unknown as Job)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(await screen.findByRole('heading', { name: '1 row refused' })).toBeInTheDocument()
    expect(screen.getByText(/give it a urn/)).toBeInTheDocument()
  })

  it('offers no way past a failure the replace guard didn’t make', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      branchId: 'br1', errorMessage: 'Stopped after the file’s first 10,000 rows',
      summary: { failure: { code: 'identifier_matched_nothing', action: 'identifier' } } } as unknown as Job)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    expect(await screen.findByText(/Stopped after the file’s first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replace anyway/ })).not.toBeInTheDocument()
  })
})
