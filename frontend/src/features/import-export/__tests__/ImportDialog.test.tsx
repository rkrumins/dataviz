/**
 * ImportDialog pins:
 *   - a file larger than one import can take is refused before any upload, saying how to split it
 *     (the proxy would otherwise answer an opaque 413 after sending it);
 *   - an import job that failed or was cancelled on the server ends as a failure that says why,
 *     never as a finished import.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  createImport: vi.fn(),
  getImport: vi.fn(),
  pollJob: vi.fn(),
}))

import { createImport, pollJob } from '@/services/importExportApiService'
import { ImportDialog } from '../ImportDialog'

function open() {
  const { container } = render(<ImportDialog wsId="ws1" graphId="g1" onClose={() => {}} />)
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

function file(name: string, size: number): File {
  const f = new File(['kind,urn\n'], name, { type: 'text/csv' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

beforeEach(() => {
  vi.mocked(createImport).mockReset()
  vi.mocked(pollJob).mockReset()
})

describe('ImportDialog', () => {
  it('refuses a file over the upload limit before sending it', async () => {
    await userEvent.upload(open(), file('graph.csv', 4.2 * 1024 ** 3))

    expect(await screen.findByText(/This file is 4\.2 GB, and one import can be at most 100\.0 MB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()
    expect(createImport).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'The job stopped before it finished. Start it again.', /The job stopped before it finished/],
    ['cancelled', null, /The import was cancelled/],
  ] as const)('ends a %s job as a failure that says why', async (status, message, shown) => {
    vi.mocked(createImport).mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'running' })
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status, errorMessage: message } as Job)
    await userEvent.upload(open(), file('graph.csv', 2048))
    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }))

    expect(await screen.findByText(shown)).toBeInTheDocument()
    expect(screen.queryByText('Import another')).not.toBeInTheDocument()
  })
})
