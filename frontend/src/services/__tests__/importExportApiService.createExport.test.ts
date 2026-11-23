/**
 * createExport pins: it asks the server, with a POST, to prepare the export chosen (the format,
 * the view, the draft, new property columns, the file's name). Entities chosen on the canvas go in
 * the body, with everything inside them asked for, and planExport asks about them the same way.
 * cancelExport asks the server, with a POST, to stop that export, and answers with its job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../apiClient', () => ({ authFetch: vi.fn() }))

import { authFetch } from '../apiClient'
import { cancelExport, createExport, exportStreamUrl, planExport } from '../importExportApiService'

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

  it('sends the entities chosen on the canvas in the body, with what is inside them', async () => {
    vi.mocked(authFetch).mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
    const target = { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', branchId: 'b1',
                     ids: ['urn:a', 'gv:e2'], withChildren: true }
    await createExport(target, 'xlsx', { filename: 'Finance-DWH-selection' })
    await planExport(target, 'xlsx')

    for (const [url, init] of vi.mocked(authFetch).mock.calls) {
      const sent = new URL(url, 'http://app')
      expect(sent.searchParams.get('withChildren')).toBe('true')
      expect(sent.searchParams.has('ids')).toBe(false)
      expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
      expect(JSON.parse(String(init?.body))).toEqual({ ids: ['urn:a', 'gv:e2'] })
    }
    expect(new URL(vi.mocked(authFetch).mock.calls[1][0], 'http://app').pathname)
      .toBe('/api/v1/ws1/versioning/graphs/g1/exports/plan')
  })

  it('asks for where each entity sits only when wanted, the stream as the job', async () => {
    vi.mocked(authFetch).mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
    const target = { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1' }
    await createExport(target, 'csv', { withPath: true })
    await createExport(target, 'csv', { withPath: false })
    const [placed, plain] = vi.mocked(authFetch).mock.calls.map(([url]) => new URL(url, 'http://app'))
    expect(placed.searchParams.get('withPath')).toBe('true')
    expect(plain.searchParams.has('withPath')).toBe(false)
    const live = new URL(exportStreamUrl({ ...target, graphId: null }, 'ndjson', { withPath: true }), 'http://app')
    expect(live.pathname).toBe('/api/v1/ws1/graph/export/stream')
    expect(live.searchParams.get('withPath')).toBe('true')
  })

  it('asks for a plan with a plain GET when nothing is chosen', async () => {
    vi.mocked(authFetch).mockResolvedValue({})
    await planExport({ wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1' }, 'csv')
    expect(vi.mocked(authFetch).mock.calls[0][1]).toBeUndefined()
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
