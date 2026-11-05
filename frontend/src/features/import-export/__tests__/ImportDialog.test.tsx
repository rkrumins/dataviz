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
 *   - the preview says why a row was refused, and shows a note on a row that applied.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  importInParts: vi.fn(),
  getImport: vi.fn(),
  getImportPreview: vi.fn(),
  pollJob: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))

import { getImportPreview, importInParts, pollJob, triggerBrowserDownload } from '@/services/importExportApiService'
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

beforeEach(() => {
  vi.mocked(importInParts).mockReset()
  vi.mocked(pollJob).mockReset()
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
    expect(screen.getByText(/when this closes/i)).toBeInTheDocument()
  })

  it('says why a row was refused, and shows a note on a row that applied', async () => {
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'completed',
      summary: { new: 0, updated: 1, deleted: 0, invalid: 1 } } as Job)
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
  })
})
