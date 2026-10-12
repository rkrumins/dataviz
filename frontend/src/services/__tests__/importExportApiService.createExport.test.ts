/**
 * createExport pins: it asks the server, with a POST, to prepare the export chosen (the format,
 * the view, the draft, new property columns, the file's name). cancelExport asks the server, with
 * a POST, to stop that export, and answers with its job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../apiClient', () => ({ authFetch: vi.fn() }))

import { authFetch } from '../apiClient'
import { cancelExport, createExport } from '../importExportApiService'

beforeEach(() => {
  localStorage.clear()
  vi.mocked(authFetch).mockReset()
})

describe('createExport', () => {
  it('asks the server to prepare the export chosen', async () => {
    vi.mocked(authFetch).mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
    await createExport({ wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: 'v1', branchId: 'b1' }, 'csv',
      { props: ['Owner', 'PII'], filename: 'Finance-DWH' })

    const [url, init] = vi.mocked(authFetch).mock.calls[0]
    const sent = new URL(url, 'http://app')
    expect(sent.pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports')
    expect(Object.fromEntries(sent.searchParams)).toEqual(
      { format: 'csv', viewId: 'v1', branchId: 'b1', props: 'Owner,PII', filename: 'Finance-DWH' })
    expect(init).toMatchObject({ method: 'POST' })
  })
})

describe('cancelExport', () => {
  it('asks the server to stop the export, and answers with its job', async () => {
    vi.mocked(authFetch).mockResolvedValue({ jobId: 'j1', jobType: 'export', graphId: 'g1', status: 'cancelled' })
    await expect(cancelExport('ws1', 'g1', 'j1')).resolves.toMatchObject({ status: 'cancelled' })

    const [url, init] = vi.mocked(authFetch).mock.calls[0]
    expect(url).toBe('/api/v1/ws1/versioning/graphs/g1/exports/j1/cancel')
    expect(init).toMatchObject({ method: 'POST' })
  })
})
